//! Agent adapters: the *only* thing `marid` knows about an agent (spec 5.6).
//!
//! Spec 2 says the user brings the agents, and spec 1.2 rejects an
//! agent-integration surface. But spec 5.6 requires the supervisor to continue
//! an unfinished run after a restart "using the resume function of the agent" —
//! and an arbitrary program has no resume function. An adapter is the thinnest
//! possible bridge between those two rules: a declarative file that names the
//! agent and, if the agent has one, the command that resumes it. Nothing in this
//! module talks to an agent, parses its output, or understands its protocol.
//!
//! An adapter is a TOML file in the adapters directory (default
//! `/etc/mari/agents.d`, `MARI_AGENTS_DIR`), with exactly these keys:
//!
//! ```toml
//! name    = "claude"                          # required, unique
//! command = ["claude", "--print"]             # required: how the agent starts
//! resume  = ["claude", "--resume", "{run}"]   # optional: how it continues
//! env     = ["ANTHROPIC_API_KEY"]             # optional: vault variable NAMES
//! cwd     = "/home/agent"                     # optional: default directory
//! ```
//!
//! Any other key makes the file malformed. A malformed, unreadable or
//! non-UTF-8 file is **skipped with a warning and recorded** — loading adapters
//! must never take the daemon down, because the daemon owns runs that have
//! nothing to do with the broken file.
//!
//! `command` is declarative: the control plane composes a run's `argv` (contracts
//! §5.2 `start_run`) and `marid` never synthesizes a run from it. What `marid`
//! uses it for is **binding**: a run whose `argv[0]` basename matches an
//! adapter's `name` or its `command[0]` basename is that agent's run, which is
//! how a restart knows whose resume template to use. Only `resume` is ever
//! spawned by this crate, after placeholder substitution:
//!
//! - `{run}` — the run id (its journal is the reference, spec 5.6)
//! - `{journal}` — absolute path of the run's local journal directory
//! - `{cwd}` — the run's working directory

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use tracing::{debug, warn};

/// One agent adapter (see the module docs for the file format).
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Adapter {
    /// Adapter name; also the default binding key for a run's `argv[0]`.
    pub name: String,
    /// How the agent is started. Declarative: used for binding, never spawned
    /// by the supervisor.
    pub command: Vec<String>,
    /// How the agent continues an unfinished run (spec 5.6). Absent means the
    /// agent has no resume function; such a run is marked interrupted at a
    /// restart instead.
    #[serde(default)]
    pub resume: Option<Vec<String>>,
    /// Names of vault variables to inject at resume (spec 10.1). Values never
    /// appear here.
    #[serde(default)]
    pub env: Vec<String>,
    /// Default working directory, used when the run's recorded cwd is empty.
    #[serde(default)]
    pub cwd: Option<String>,
}

/// The substitutions available to a resume template.
#[derive(Clone, Debug)]
pub struct ResumeContext {
    /// The run being resumed.
    pub run: String,
    /// Absolute path of the run's local journal directory (spec 5.6: the
    /// journal is the reference for the resume).
    pub journal_dir: String,
    /// The run's working directory.
    pub cwd: String,
}

impl Adapter {
    /// Does this adapter own a run started as `argv`? The binding is the
    /// program name only: `argv[0]`'s basename equal to the adapter `name` or to
    /// the basename of its declared `command[0]`.
    pub fn matches_argv(&self, argv: &[String]) -> bool {
        let Some(prog) = argv.first().map(|p| basename(p)) else {
            return false;
        };
        if prog == self.name {
            return true;
        }
        self.command
            .first()
            .map(|c| basename(c) == prog)
            .unwrap_or(false)
    }

    /// The concrete argv that resumes `ctx`'s run, or `None` when this adapter
    /// declares no resume function. Placeholders are substituted per argument;
    /// an unknown `{...}` is left untouched (it may be the agent's own syntax).
    pub fn resume_argv(&self, ctx: &ResumeContext) -> Option<Vec<String>> {
        let template = self.resume.as_ref()?;
        if template.is_empty() {
            return None;
        }
        Some(
            template
                .iter()
                .map(|arg| {
                    arg.replace("{run}", &ctx.run)
                        .replace("{journal}", &ctx.journal_dir)
                        .replace("{cwd}", &ctx.cwd)
                })
                .collect(),
        )
    }
}

/// Every adapter loaded from the adapters directory, plus the files that were
/// rejected (kept so a test — or an operator reading the log — can see exactly
/// which file was bad and why).
#[derive(Clone, Debug, Default)]
pub struct AdapterSet {
    by_name: BTreeMap<String, Adapter>,
    rejected: Vec<(PathBuf, String)>,
}

impl AdapterSet {
    /// Load every `*.toml` in `dir`, in filename order.
    ///
    /// Infallible by construction: a missing directory yields an empty set, and
    /// a file that fails to read, decode or validate is skipped and recorded in
    /// [`AdapterSet::rejected`]. A duplicate `name` keeps the first file in
    /// filename order and rejects the later one, so loading is deterministic.
    pub fn load_dir(dir: impl AsRef<Path>) -> Self {
        let dir = dir.as_ref();
        let mut set = AdapterSet::default();
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(e) => {
                debug!(dir = %dir.display(), "no agent adapters loaded: {e}");
                return set;
            }
        };
        let mut paths: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("toml"))
            .collect();
        paths.sort();
        for path in paths {
            match Self::load_file(&path) {
                Ok(adapter) => {
                    if set.by_name.contains_key(&adapter.name) {
                        set.reject(&path, format!("duplicate adapter name {:?}", adapter.name));
                        continue;
                    }
                    debug!(name = %adapter.name, path = %path.display(), "loaded agent adapter");
                    set.by_name.insert(adapter.name.clone(), adapter);
                }
                Err(e) => set.reject(&path, e),
            }
        }
        set
    }

    /// Parse and validate one adapter file.
    fn load_file(path: &Path) -> Result<Adapter, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("read: {e}"))?;
        let adapter: Adapter = toml::from_str(&text).map_err(|e| format!("parse: {e}"))?;
        if adapter.name.trim().is_empty() {
            return Err("`name` must not be empty".to_string());
        }
        if adapter.command.is_empty() {
            return Err("`command` must have at least the program".to_string());
        }
        if adapter.command.iter().any(|a| a.is_empty()) {
            return Err("`command` must not contain an empty argument".to_string());
        }
        if let Some(resume) = &adapter.resume
            && (resume.is_empty() || resume.iter().any(|a| a.is_empty()))
        {
            return Err("`resume` must not be empty or contain an empty argument".to_string());
        }
        Ok(adapter)
    }

    fn reject(&mut self, path: &Path, reason: impl Into<String>) {
        let reason = reason.into();
        warn!(path = %path.display(), "ignoring malformed agent adapter: {reason}");
        self.rejected.push((path.to_path_buf(), reason));
    }

    /// The adapter with this name.
    pub fn get(&self, name: &str) -> Option<&Adapter> {
        self.by_name.get(name)
    }

    /// The adapter that owns a run started as `argv`, if any.
    pub fn match_argv(&self, argv: &[String]) -> Option<&Adapter> {
        self.by_name.values().find(|a| a.matches_argv(argv))
    }

    /// Number of adapters loaded.
    pub fn len(&self) -> usize {
        self.by_name.len()
    }

    /// True when no adapter loaded.
    pub fn is_empty(&self) -> bool {
        self.by_name.is_empty()
    }

    /// Adapter names, in load (name) order.
    pub fn names(&self) -> Vec<&str> {
        self.by_name.keys().map(String::as_str).collect()
    }

    /// The files that were rejected, with the reason each was rejected.
    pub fn rejected(&self) -> &[(PathBuf, String)] {
        &self.rejected
    }
}

/// The final path segment of a program name (`/usr/bin/claude` -> `claude`).
fn basename(program: &str) -> &str {
    program.rsplit('/').next().unwrap_or(program)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, body: &str) {
        std::fs::write(dir.join(name), body).unwrap();
    }

    fn ctx() -> ResumeContext {
        ResumeContext {
            run: "run-77".into(),
            journal_dir: "/srv/.mari/journal/run-77".into(),
            cwd: "/work".into(),
        }
    }

    #[test]
    fn a_full_adapter_parses_and_its_resume_template_substitutes() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "claude.toml",
            r#"
name    = "claude"
command = ["/usr/local/bin/claude", "--print"]
resume  = ["claude", "--resume", "{run}", "--journal", "{journal}", "--cd", "{cwd}"]
env     = ["ANTHROPIC_API_KEY"]
cwd     = "/home/agent"
"#,
        );
        let set = AdapterSet::load_dir(dir.path());
        assert_eq!(set.names(), vec!["claude"]);
        assert!(set.rejected().is_empty(), "{:?}", set.rejected());

        let a = set.get("claude").unwrap();
        assert_eq!(a.env, vec!["ANTHROPIC_API_KEY".to_string()]);
        assert_eq!(a.cwd.as_deref(), Some("/home/agent"));
        assert_eq!(
            a.resume_argv(&ctx()).unwrap(),
            vec![
                "claude",
                "--resume",
                "run-77",
                "--journal",
                "/srv/.mari/journal/run-77",
                "--cd",
                "/work"
            ]
        );
        // Binding: by adapter name, by the declared command's basename, and by a
        // fully-qualified path to that program. Not by an unrelated program.
        assert!(a.matches_argv(&["claude".into(), "--print".into()]));
        assert!(a.matches_argv(&["/opt/bin/claude".into()]));
        assert!(!a.matches_argv(&["bash".into()]));
        assert!(!a.matches_argv(&[]));
    }

    #[test]
    fn an_adapter_without_a_resume_template_declares_no_resume() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "plain.toml",
            "name = \"plain\"\ncommand = [\"plain-agent\"]\n",
        );
        let set = AdapterSet::load_dir(dir.path());
        let a = set.get("plain").unwrap();
        assert_eq!(a.resume, None);
        assert!(
            a.resume_argv(&ctx()).is_none(),
            "no resume template means the supervisor has nothing to spawn"
        );
    }

    /// Every malformed file is skipped — loading adapters must never take the
    /// daemon down — and the good files in the same directory still load.
    #[test]
    fn malformed_files_are_skipped_and_the_good_ones_still_load() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "01-good.toml",
            "name = \"good\"\ncommand = [\"good\"]\n",
        );
        // Not TOML at all.
        write(dir.path(), "02-garbage.toml", "}{ this is not toml \0\x01");
        // Unknown key: spec 1.2 — the adapter surface is exactly five keys, so a
        // sixth is a malformed file, not a silently ignored extra.
        write(
            dir.path(),
            "03-extra.toml",
            "name = \"extra\"\ncommand = [\"x\"]\nprompt = \"be nice\"\n",
        );
        // Missing the required `command`.
        write(dir.path(), "04-nocommand.toml", "name = \"nocmd\"\n");
        // Empty name / empty command / empty resume argument.
        write(
            dir.path(),
            "05-emptyname.toml",
            "name = \"  \"\ncommand = [\"x\"]\n",
        );
        write(
            dir.path(),
            "06-emptycmd.toml",
            "name = \"e\"\ncommand = []\n",
        );
        write(
            dir.path(),
            "07-emptyresume.toml",
            "name = \"r\"\ncommand = [\"x\"]\nresume = []\n",
        );
        // Wrong type for a known key.
        write(
            dir.path(),
            "08-badtype.toml",
            "name = \"b\"\ncommand = \"x\"\n",
        );
        // A duplicate of the first adapter's name: first file in filename order wins.
        write(
            dir.path(),
            "09-dup.toml",
            "name = \"good\"\ncommand = [\"other\"]\n",
        );
        // Not a .toml file at all: ignored silently, not rejected.
        write(
            dir.path(),
            "notes.txt",
            "name = \"nope\"\ncommand = [\"nope\"]\n",
        );
        // Another good one, to prove loading continues past every failure.
        write(
            dir.path(),
            "10-good2.toml",
            "name = \"good2\"\ncommand = [\"good2\"]\nresume = [\"good2\", \"--resume\", \"{run}\"]\n",
        );

        let set = AdapterSet::load_dir(dir.path());
        assert_eq!(
            set.names(),
            vec!["good", "good2"],
            "exactly the well-formed adapters load"
        );
        // The first `good` file won; the duplicate did not replace its command.
        assert_eq!(set.get("good").unwrap().command, vec!["good".to_string()]);
        assert_eq!(
            set.get("good2").unwrap().resume_argv(&ctx()).unwrap(),
            vec!["good2", "--resume", "run-77"]
        );
        let rejected: Vec<String> = set
            .rejected()
            .iter()
            .map(|(p, _)| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(
            rejected,
            vec![
                "02-garbage.toml",
                "03-extra.toml",
                "04-nocommand.toml",
                "05-emptyname.toml",
                "06-emptycmd.toml",
                "07-emptyresume.toml",
                "08-badtype.toml",
                "09-dup.toml",
            ],
            "every malformed file is reported, with its reason"
        );
        assert!(
            set.rejected()
                .iter()
                .any(|(p, why)| p.ends_with("03-extra.toml") && why.contains("prompt")),
            "the unknown-key rejection must name the offending key: {:?}",
            set.rejected()
        );
    }

    #[test]
    fn a_missing_or_empty_directory_is_not_an_error() {
        let set = AdapterSet::load_dir("/nonexistent/mari/agents.d");
        assert!(set.is_empty() && set.rejected().is_empty());
        let dir = tempfile::tempdir().unwrap();
        let set = AdapterSet::load_dir(dir.path());
        assert_eq!(set.len(), 0);
        assert!(set.match_argv(&["anything".into()]).is_none());
    }

    #[test]
    fn an_unknown_placeholder_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "a.toml",
            "name = \"a\"\ncommand = [\"a\"]\nresume = [\"a\", \"--session={run}\", \"--fmt={json}\"]\n",
        );
        let set = AdapterSet::load_dir(dir.path());
        assert_eq!(
            set.get("a").unwrap().resume_argv(&ctx()).unwrap(),
            vec!["a", "--session=run-77", "--fmt={json}"],
            "an agent's own brace syntax must survive substitution"
        );
    }
}
