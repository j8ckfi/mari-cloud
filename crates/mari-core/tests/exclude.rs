//! Credential paths (spec 10.1) must never enter a manifest — not the entry,
//! and not the chunk bytes.
//!
//! Exclusion is by path, so the tests at the bottom cover the shape that makes a
//! path a poor name for a file: a **hard link**, a second name for one inode.
//! A snapshot may only store bytes it can prove belong to this computer, and it
//! proves that by accounting for every name an inode has — not by trusting the
//! name it walked in through.

use std::os::unix::fs::MetadataExt;

use mari_core::{snapshot, ChunkStore, ChunkerConfig, SnapshotOptions};

fn small_chunker() -> ChunkerConfig {
    ChunkerConfig {
        min: 2048,
        avg: 4096,
        max: 16384,
    }
}

#[tokio::test]
async fn excluded_credentials_leave_no_trace() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    let store = ChunkStore::open_fs(tmp.path().join("store")).unwrap();

    // A credential dir with a distinctive secret, and normal files alongside.
    std::fs::create_dir_all(src.join("home/.aws")).unwrap();
    let secret = b"AWS_SECRET_ACCESS_KEY=super-secret-do-not-store";
    std::fs::write(src.join("home/.aws/credentials"), secret).unwrap();
    std::fs::write(src.join("home/.aws/config"), b"[default]\nregion=us-east-1\n").unwrap();
    std::fs::write(src.join("home/notes.txt"), b"public notes").unwrap();

    let opts = SnapshotOptions {
        chunker: small_chunker(),
        exclude: vec!["*/.aws*".to_string()],
        parent: None,
        created_at: 0,
    };
    let snap = snapshot(&store, &src, &opts).await.unwrap();

    // No manifest entry mentions .aws.
    for e in &snap.manifest.entries {
        assert!(
            !e.path.contains(".aws"),
            "credential path leaked into manifest: {}",
            e.path
        );
    }
    // The normal file survived.
    assert!(snap.manifest.entries.iter().any(|e| e.path == "/home/notes.txt"));

    // The secret's bytes were never chunked/uploaded: its chunk id is absent.
    let secret_chunk = ChunkStore::chunk_id(secret);
    assert!(
        !store.has_chunk(&secret_chunk).await.unwrap(),
        "excluded credential bytes were uploaded to the store!"
    );

    // The exclusion was reported.
    assert!(
        snap.excluded.iter().any(|p| p.contains(".aws")),
        "excluded list should record the credential path"
    );
}

#[tokio::test]
async fn default_excludes_cover_ssh_keys() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    let store = ChunkStore::open_fs(tmp.path().join("store")).unwrap();

    std::fs::create_dir_all(src.join("root/.ssh")).unwrap();
    let key = b"-----BEGIN OPENSSH PRIVATE KEY-----\nsensitive\n";
    std::fs::write(src.join("root/.ssh/id_ed25519"), key).unwrap();
    std::fs::write(src.join("root/keep.txt"), b"keep me").unwrap();

    // Default options carry the credential exclude list.
    let opts = SnapshotOptions {
        chunker: small_chunker(),
        created_at: 0,
        ..SnapshotOptions::default()
    };
    let snap = snapshot(&store, &src, &opts).await.unwrap();

    assert!(
        !snap.manifest.entries.iter().any(|e| e.path.contains(".ssh")),
        "default excludes should drop .ssh"
    );
    assert!(snap.manifest.entries.iter().any(|e| e.path == "/root/keep.txt"));
    assert!(!store.has_chunk(&ChunkStore::chunk_id(key)).await.unwrap());
}

/// A run can leave a second name, inside the root, for an inode that lives
/// outside it. Nothing about that name is suspicious: it is a regular file, it
/// is not a symlink, and every path check passes. The snapshot must still refuse
/// its bytes — a chunk is shared by every manifest that references it, so one
/// ingested secret is in every fork of this computer forever (spec 10.1, 10.2).
#[tokio::test]
async fn a_hardlink_to_an_inode_outside_the_root_is_dropped_unread() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let outside = tmp.path().join("outside");
    let store = ChunkStore::open_fs(tmp.path().join("store")).unwrap();
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&outside).unwrap();

    let secret = b"TOP-SECRET-OUTSIDE-THE-ROOT";
    std::fs::write(outside.join("secret"), secret).unwrap();
    std::fs::hard_link(outside.join("secret"), root.join("innocent.txt")).unwrap();
    std::fs::write(root.join("keep.txt"), b"ordinary content").unwrap();

    let opts = SnapshotOptions {
        chunker: small_chunker(),
        created_at: 0,
        ..SnapshotOptions::default()
    };
    let snap = snapshot(&store, &root, &opts).await.unwrap();

    assert!(
        !snap
            .manifest
            .entries
            .iter()
            .any(|e| e.path == "/innocent.txt"),
        "a name for an inode outside the root became a manifest entry"
    );
    assert!(
        !store
            .has_chunk(&ChunkStore::chunk_id(secret))
            .await
            .unwrap(),
        "the outside file's bytes were chunked into the store"
    );
    assert_eq!(
        snap.unattributable_links,
        vec!["/innocent.txt".to_string()],
        "the drop must be reported, not silent"
    );
    // The rest of the tree is unaffected: refusing one inode is not a refusal to
    // snapshot (a checkpoint one `link()` call can kill is its own defect).
    let keep = snap
        .manifest
        .entries
        .iter()
        .find(|e| e.path == "/keep.txt")
        .expect("the ordinary file must still be snapshotted");
    assert_eq!(keep.size, b"ordinary content".len() as u64);
    assert!(store
        .has_chunk(&ChunkStore::chunk_id(b"ordinary content"))
        .await
        .unwrap());
}

/// The other half, and the reason the check counts names instead of refusing
/// every `st_nlink > 1`: hard links *inside* the root are ordinary content (`git
/// clone --local` makes thousands of them). Both names are the computer's, so
/// both are snapshotted — as independent entries, because a manifest has no
/// hard-link concept — and content addressing means the bytes are stored once.
#[tokio::test]
async fn hard_links_wholly_inside_the_root_are_both_snapshotted() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let store = ChunkStore::open_fs(tmp.path().join("store")).unwrap();
    std::fs::create_dir_all(root.join("clone")).unwrap();

    let content = b"shared by two names inside the root";
    std::fs::write(root.join("original.bin"), content).unwrap();
    std::fs::hard_link(root.join("original.bin"), root.join("clone/linked.bin")).unwrap();
    assert_eq!(
        std::fs::metadata(root.join("original.bin")).unwrap().nlink(),
        2,
        "precondition: one inode, two names, both inside the root"
    );

    let opts = SnapshotOptions {
        chunker: small_chunker(),
        created_at: 0,
        ..SnapshotOptions::default()
    };
    let snap = snapshot(&store, &root, &opts).await.unwrap();

    assert!(
        snap.unattributable_links.is_empty(),
        "in-root hard links are attributable: {:?}",
        snap.unattributable_links
    );
    let original = snap
        .manifest
        .entries
        .iter()
        .find(|e| e.path == "/original.bin")
        .expect("the original must be in the manifest");
    let linked = snap
        .manifest
        .entries
        .iter()
        .find(|e| e.path == "/clone/linked.bin")
        .expect("the second name must be in the manifest too");
    assert_eq!(original.size, content.len() as u64);
    assert_eq!(original.chunks, linked.chunks, "same content, same chunks");
    let stored = store
        .get_chunk(&original.chunks[0].chunk)
        .await
        .expect("the content must be in the store");
    assert_eq!(stored, content);
}

/// The inbound version of the credential escape: the exclude list drops
/// `~/.ssh`, but a hard link gives the same inode a second, innocent-looking
/// name. Spec 10.1 is about the bytes, not about the spelling of the path, so
/// the innocent name must not carry the key into the manifest either.
#[tokio::test]
async fn a_hardlink_out_of_an_excluded_credential_path_smuggles_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let store = ChunkStore::open_fs(tmp.path().join("store")).unwrap();
    std::fs::create_dir_all(root.join("root/.ssh")).unwrap();

    let key = b"-----BEGIN OPENSSH PRIVATE KEY-----\nsmuggled\n";
    std::fs::write(root.join("root/.ssh/id_ed25519"), key).unwrap();
    // What a run does: a second name for the key, at a path no exclude matches.
    std::fs::hard_link(root.join("root/.ssh/id_ed25519"), root.join("notes.txt")).unwrap();

    let opts = SnapshotOptions {
        chunker: small_chunker(),
        created_at: 0,
        ..SnapshotOptions::default()
    };
    let snap = snapshot(&store, &root, &opts).await.unwrap();

    assert!(
        !snap.manifest.entries.iter().any(|e| e.path == "/notes.txt"),
        "an excluded credential re-entered the manifest under another name"
    );
    assert!(
        !store.has_chunk(&ChunkStore::chunk_id(key)).await.unwrap(),
        "excluded credential bytes were uploaded under another name"
    );
    assert_eq!(snap.unattributable_links, vec!["/notes.txt".to_string()]);
}
