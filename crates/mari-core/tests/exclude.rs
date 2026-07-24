//! Credential paths (spec 10.1) must never enter a manifest — not the entry,
//! and not the chunk bytes.

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
