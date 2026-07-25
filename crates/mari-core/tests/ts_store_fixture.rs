//! Cross-language fixture generator: a REAL store, written by `mari-core`, that
//! the TypeScript control plane reads back through its HTTP file routes.
//!
//! Why it exists. `mari-core` stores chunk bodies **zstd-compressed** and hashes
//! the *plaintext* with blake3 (`src/store.rs`). The control plane's chunk reader
//! must therefore decompress and re-verify, and a fixture the TypeScript side
//! generated itself would prove nothing about that interoperability — it would
//! only prove TS agrees with TS. So this test snapshots a tree with the real
//! chunker, then writes the store's bytes VERBATIM (base64) into
//! `packages/control-plane/test/fixtures/mari-core-store.json`, together with the
//! plaintext each file must read back as.
//!
//! Regenerate with:
//!
//! ```sh
//! cargo test -p mari-core --test ts_store_fixture
//! ```
//!
//! The tree deliberately covers the cases a chunk reader gets wrong:
//! a small text file, a UTF-8 file with multi-byte characters, an EMPTY file
//! (zero chunk refs), a high-entropy binary (zstd cannot shrink it, so its
//! stored body is a frame of raw blocks), a file that spans MANY chunks (so
//! concatenation order is observable), and a file built from repeated blocks so
//! the same chunk id appears in the ref list more than once.
//!
//! This test is self-checking: it asserts the store round-trips through
//! `ChunkStore::get_chunk` (verify-then-use) and that the bytes it emits
//! reassemble into the source files, so a broken fixture fails here rather than
//! in another language's suite.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use mari_core::{ChunkStore, ChunkerConfig, SnapshotOptions, snapshot};
use mari_proto::{ChunkId, EntryKind};

/// splitmix64 — deterministic pseudo-random bytes, so the fixture is stable.
fn splitmix(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

fn gen_bytes(seed: u64, len: usize) -> Vec<u8> {
    let mut s = seed;
    let mut out = Vec::with_capacity(len + 8);
    while out.len() < len {
        out.extend_from_slice(&splitmix(&mut s).to_le_bytes());
    }
    out.truncate(len);
    out
}

/// Base64 (RFC 4648, standard alphabet, padded). Hand-rolled: `mari-core` has no
/// base64 dependency and this test must not add one to the crate's manifest.
fn b64(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let b0 = c[0] as u32;
        let b1 = *c.get(1).unwrap_or(&0) as u32;
        let b2 = *c.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(A[(n >> 18) as usize & 63] as char);
        out.push(A[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 {
            A[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if c.len() > 2 {
            A[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn fixtures_dir() -> PathBuf {
    let p =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/control-plane/test/fixtures");
    fs::create_dir_all(&p).expect("create fixtures dir");
    p.canonicalize().expect("canonicalize fixtures dir")
}

/// Small chunker so a 24 KiB file spans many chunks without a huge fixture.
/// (Production is 64 KiB/256 KiB/1 MiB — chunk sizes are the writer's choice;
/// the reader only concatenates the refs a manifest names, in order.)
fn fixture_chunker() -> ChunkerConfig {
    let c = ChunkerConfig {
        min: 2048,
        avg: 4096,
        max: 16384,
    };
    c.validate().unwrap();
    c
}

#[tokio::test]
async fn writes_ts_store_fixture() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("root");
    let store_dir = tmp.path().join("store");
    fs::create_dir_all(src.join("notes")).unwrap();
    fs::create_dir_all(src.join("bin")).unwrap();

    // One 4 KiB high-entropy block, repeated 4x: CDC cuts the repeats
    // identically, so the same chunk id lands in the ref list several times.
    let block = gen_bytes(0xA1B2_C3D4, 4096);
    let mut repeated = Vec::new();
    for _ in 0..4 {
        repeated.extend_from_slice(&block);
    }

    let mut want: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    want.insert(
        "/README.md".into(),
        b"# real computer\n\nThis tree was written by mari-core.\n".to_vec(),
    );
    // Multi-byte UTF-8 + a NUL + a lone CR: byte-exactness, not text-exactness.
    want.insert(
        "/notes/utf8.txt".into(),
        "héllo — ünïcode ✓ 日本語\r\n\0tail\n".as_bytes().to_vec(),
    );
    // An empty file: zero chunk refs, and it must still read back as 0 bytes.
    want.insert("/empty.bin".into(), Vec::new());
    // High-entropy: zstd cannot compress it, so the stored frame carries raw
    // blocks — a reader that "helpfully" skips decompression looks almost right.
    want.insert("/bin/entropy.bin".into(), gen_bytes(0x5EED_1234, 4096));
    // Spans many chunks: proves concatenation ORDER.
    want.insert("/bin/multi.bin".into(), gen_bytes(0x0BAD_F00D, 24 * 1024));
    // Repeated blocks: the same chunk id appears in the ref list repeatedly.
    want.insert("/bin/repeat.bin".into(), repeated);

    for (path, content) in &want {
        let on_disk = src.join(path.trim_start_matches('/'));
        fs::write(&on_disk, content).unwrap();
    }

    let store = ChunkStore::open_fs(&store_dir).unwrap();
    let opts = SnapshotOptions {
        chunker: fixture_chunker(),
        exclude: vec![],
        parent: None,
        created_at: 1_700_000_000,
    };
    let snap = snapshot(&store, &src, &opts).await.unwrap();

    // ---- teeth on the fixture itself ----------------------------------
    let by_path: BTreeMap<&str, &mari_proto::ManifestEntry> = snap
        .manifest
        .entries
        .iter()
        .map(|e| (e.path.as_str(), e))
        .collect();

    let multi = by_path["/bin/multi.bin"];
    assert!(
        multi.chunks.len() > 4,
        "multi.bin must span several chunks, got {}",
        multi.chunks.len()
    );
    let repeat = by_path["/bin/repeat.bin"];
    let distinct: std::collections::HashSet<&ChunkId> =
        repeat.chunks.iter().map(|r| &r.chunk).collect();
    assert!(
        repeat.chunks.len() > distinct.len(),
        "repeat.bin must reference at least one chunk twice ({} refs, {} distinct)",
        repeat.chunks.len(),
        distinct.len()
    );
    assert!(
        by_path["/empty.bin"].chunks.is_empty(),
        "an empty file has zero chunk refs"
    );

    // Every file reassembles from verified chunks, in ref order.
    for (path, content) in &want {
        let e = by_path[path.as_str()];
        assert_eq!(e.kind, EntryKind::File, "{path} is a file");
        assert_eq!(e.size as usize, content.len(), "{path} size");
        let mut asm = Vec::new();
        for r in &e.chunks {
            let plain = store.get_chunk(&r.chunk).await.expect("verified chunk");
            assert_eq!(plain.len() as u64, r.len, "{path}: chunk len matches ref");
            asm.extend_from_slice(&plain);
        }
        assert_eq!(&asm, content, "{path} reassembles byte-for-byte");
    }

    // ---- emit the fixture ---------------------------------------------
    let manifest_cbor = fs::read(
        store_dir
            .join("manifests")
            .join(format!("{}.cbor", snap.manifest_id)),
    )
    .expect("manifest object on disk");
    assert_eq!(
        ChunkStore::manifest_id_of_cbor(&manifest_cbor).as_str(),
        snap.manifest_id.as_str(),
        "manifest id is the blake3 of the stored CBOR"
    );

    // Read the chunk objects EXACTLY as the store holds them (compressed).
    let mut chunk_rows: Vec<String> = Vec::new();
    let mut chunk_ids: Vec<ChunkId> = snap
        .manifest
        .entries
        .iter()
        .flat_map(|e| e.chunks.iter().map(|r| r.chunk.clone()))
        .collect();
    chunk_ids.sort();
    chunk_ids.dedup();
    for id in &chunk_ids {
        let key = ChunkStore::chunk_key(id);
        let stored = fs::read(store_dir.join(&key)).expect("chunk object on disk");
        assert_ne!(
            stored,
            store.get_chunk(id).await.unwrap(),
            "stored body must differ from the plaintext — it is a zstd frame"
        );
        chunk_rows.push(format!(
            "    {{ \"id\": {}, \"key\": {}, \"storedBase64\": {} }}",
            json_str(id.as_str()),
            json_str(&key),
            json_str(&b64(&stored))
        ));
    }

    let mut file_rows: Vec<String> = Vec::new();
    for (path, content) in &want {
        let e = by_path[path.as_str()];
        let refs: Vec<String> = e
            .chunks
            .iter()
            .map(|r| {
                format!(
                    "{{ \"chunk\": {}, \"len\": {} }}",
                    json_str(r.chunk.as_str()),
                    r.len
                )
            })
            .collect();
        file_rows.push(format!(
            "    {{ \"path\": {}, \"size\": {}, \"mode\": {}, \"chunks\": [{}], \"contentBase64\": {} }}",
            json_str(path),
            e.size,
            e.mode,
            refs.join(", "),
            json_str(&b64(content))
        ));
    }

    let dirs: Vec<String> = snap
        .manifest
        .entries
        .iter()
        .filter(|e| e.kind == EntryKind::Dir)
        .map(|e| json_str(&e.path))
        .collect();

    let json = format!(
        concat!(
            "{{\n",
            "  \"_generatedBy\": \"cargo test -p mari-core --test ts_store_fixture\",\n",
            "  \"_note\": \"Store objects written by mari-core, verbatim. Chunk bodies are ZSTD frames; ids are blake3 of the PLAINTEXT.\",\n",
            "  \"chunker\": {{ \"min\": {}, \"avg\": {}, \"max\": {} }},\n",
            "  \"manifestId\": {},\n",
            "  \"manifestKey\": {},\n",
            "  \"manifestCborBase64\": {},\n",
            "  \"dirs\": [{}],\n",
            "  \"files\": [\n{}\n  ],\n",
            "  \"chunks\": [\n{}\n  ]\n",
            "}}\n"
        ),
        fixture_chunker().min,
        fixture_chunker().avg,
        fixture_chunker().max,
        json_str(snap.manifest_id.as_str()),
        json_str(&ChunkStore::manifest_key(&snap.manifest_id)),
        json_str(&b64(&manifest_cbor)),
        dirs.join(", "),
        file_rows.join(",\n"),
        chunk_rows.join(",\n"),
    );

    let out = fixtures_dir().join("mari-core-store.json");
    fs::write(&out, json).expect("write fixture");
    eprintln!("wrote {}", out.display());
}
