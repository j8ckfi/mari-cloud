//! Shared test helpers: deterministic byte generation and byte-level tree
//! comparison. No randomness that isn't seeded, so failures reproduce.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;

use walkdir::WalkDir;

/// splitmix64: a tiny deterministic PRNG for generating file content.
pub fn splitmix(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Deterministic pseudo-random bytes of length `len` from `seed`.
pub fn gen_bytes(seed: u64, len: usize) -> Vec<u8> {
    let mut s = seed;
    let mut out = Vec::with_capacity(len + 8);
    while out.len() < len {
        out.extend_from_slice(&splitmix(&mut s).to_le_bytes());
    }
    out.truncate(len);
    out
}

/// A filesystem node reduced to what a byte-identical restore must preserve.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Node {
    /// A regular file: permission bits and exact content.
    File { perms: u32, content: Vec<u8> },
    /// A directory: permission bits.
    Dir { perms: u32 },
    /// A symlink: its link text (we do not restore symlink modes).
    Symlink { target: String },
}

/// Read a tree into a map of `relative-path -> Node`, skipping the root itself.
/// Symlinks are not followed. Permission bits are masked to `0o7777`.
pub fn read_tree(root: &Path) -> BTreeMap<String, Node> {
    let mut map = BTreeMap::new();
    for entry in WalkDir::new(root).sort_by_file_name() {
        let entry = entry.expect("walk");
        let rel = entry
            .path()
            .strip_prefix(root)
            .expect("under root")
            .to_str()
            .expect("utf8")
            .to_string();
        if rel.is_empty() {
            continue; // skip the root
        }
        let ft = entry.file_type();
        let meta = entry.metadata().expect("metadata");
        let node = if ft.is_dir() {
            Node::Dir {
                perms: meta.mode() & 0o7777,
            }
        } else if ft.is_symlink() {
            let target = std::fs::read_link(entry.path())
                .expect("read_link")
                .to_str()
                .expect("utf8 target")
                .to_string();
            Node::Symlink { target }
        } else {
            let content = std::fs::read(entry.path()).expect("read file");
            Node::File {
                perms: meta.mode() & 0o7777,
                content,
            }
        };
        map.insert(rel, node);
    }
    map
}

/// Set a path's permission bits.
pub fn chmod(path: &Path, mode: u32) {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).expect("chmod");
}

/// Build a representative source tree covering the required edge cases and
/// return the map it should round-trip to (its own `read_tree`). Modes are set
/// explicitly so the comparison has teeth.
///
/// Contents: nested dirs with non-default modes, a valid relative symlink, an
/// absolute symlink, a dangling symlink, an empty file, an exec-bit file, a file
/// whose name contains a space, and a multi-megabyte file that spans many
/// chunks.
pub fn build_reference_tree(root: &Path) {
    use std::os::unix::fs::symlink;

    // Directories with explicit modes.
    let data = root.join("data");
    let nested = data.join("nested");
    std::fs::create_dir_all(&nested).unwrap();

    // Empty file.
    std::fs::write(root.join("empty.txt"), b"").unwrap();
    chmod(&root.join("empty.txt"), 0o644);

    // Exec-bit file.
    std::fs::write(root.join("run.sh"), b"#!/bin/sh\necho hi\n").unwrap();
    chmod(&root.join("run.sh"), 0o755);

    // File with a space in the name.
    std::fs::write(root.join("weird name.txt"), b"spaces are allowed\n").unwrap();
    chmod(&root.join("weird name.txt"), 0o640);

    // Small files in nested dirs, distinct modes.
    std::fs::write(data.join("a.txt"), gen_bytes(1, 300)).unwrap();
    chmod(&data.join("a.txt"), 0o600);
    std::fs::write(nested.join("b.txt"), gen_bytes(2, 4096)).unwrap();
    chmod(&nested.join("b.txt"), 0o644);

    // Multi-megabyte file that will span many chunks.
    std::fs::write(root.join("big.bin"), gen_bytes(42, 3 * 1024 * 1024)).unwrap();
    chmod(&root.join("big.bin"), 0o644);

    // Symlinks: valid relative, absolute, and dangling.
    symlink("data/a.txt", root.join("link_rel")).unwrap();
    symlink("/etc/hostname", root.join("link_abs")).unwrap();
    symlink("this-target-does-not-exist", root.join("dangling")).unwrap();

    // Dir modes set last so writing children was not blocked.
    chmod(&nested, 0o700);
    chmod(&data, 0o750);
}
