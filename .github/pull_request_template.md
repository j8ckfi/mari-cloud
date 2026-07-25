<!--
Not a form to fill in for its own sake. Three questions, because they are the
three that decide whether a change belongs in Mari (CONTRIBUTING.md).
-->

**What this is, against spec 1.1.** Is it the emulator, the interface, or a
primitive? If it is none of the three, spec 1.2 says to reject it — make the case
here.

**Which spec clause it implements or changes.** Link it. If it diverges from
`docs/decisions.md`, append the argument there rather than diverging silently.

**Which test would fail if this regressed.** Name the file. "It typechecks" and
"I tried it locally" are not answers; neither is a test that cannot fail.

---

- [ ] Lane respected — no edits to another owner's directory to make this compile
- [ ] `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`
- [ ] `pnpm -r typecheck && pnpm -r test`
- [ ] Docker suites, if this touches wake, restore, the tier policy or a substrate: add the **`e2e`** label
- [ ] No assertion was weakened, widened or skipped to reach green
