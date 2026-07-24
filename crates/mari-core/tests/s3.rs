//! S3 backend round-trip, gated twice: the whole file compiles only under the
//! `s3` feature, and the test body runs only when live credentials are present
//! (`MARI_S3_TEST_BUCKET` plus the usual `AWS_*` environment). Without creds it
//! no-ops, so `cargo test -p mari-core --features s3` stays green offline.
#![cfg(feature = "s3")]

use mari_core::{ChunkId, ChunkStore, Error};

#[tokio::test]
async fn s3_chunk_roundtrip_if_creds_present() {
    let Ok(bucket) = std::env::var("MARI_S3_TEST_BUCKET") else {
        eprintln!("skipping s3 test: MARI_S3_TEST_BUCKET not set");
        return;
    };
    let region = std::env::var("MARI_S3_TEST_REGION").unwrap_or_else(|_| "us-east-1".into());
    let endpoint = std::env::var("MARI_S3_TEST_ENDPOINT").ok();
    let root = format!("mari-core-test/{}/", std::process::id());

    let store = ChunkStore::open_s3(&bucket, &region, &root, endpoint.as_deref()).unwrap();

    let payload = b"s3 verify-then-use round-trip payload";
    let id = store.put_chunk(payload).await.unwrap();
    assert!(store.has_chunk(&id).await.unwrap());
    // Verified read returns exactly the bytes.
    assert_eq!(store.get_chunk(&id).await.unwrap(), payload);

    // A missing chunk reports the typed error on S3 as well.
    let bogus = ChunkId::new("0".repeat(64));
    assert!(matches!(
        store.get_chunk(&bogus).await,
        Err(Error::ChunkMissing(_))
    ));

    store.delete_chunk(&id).await.unwrap();
    assert!(!store.has_chunk(&id).await.unwrap());
}
