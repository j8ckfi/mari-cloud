//! Parse a `MARI_STORE` URI into a [`ChunkStore`].
//!
//! `fs:///abs/path` opens a local filesystem store (always available); the
//! authority is empty and the remainder is an absolute path. `s3://bucket/root`
//! opens an S3-compatible store, but only when the crate is built with the `s3`
//! feature (which forwards to `mari-core/s3`). An unknown scheme is an error.

use anyhow::{Context, Result, anyhow};
use mari_core::ChunkStore;

/// Open the chunk store named by a `MARI_STORE` URI.
pub fn open_store(uri: &str) -> Result<ChunkStore> {
    if let Some(rest) = uri.strip_prefix("fs://") {
        // `fs:///abs/path` -> authority empty, path `/abs/path`.
        // `fs://relative` -> `relative` (rare; used in tests occasionally).
        let path = rest;
        if path.is_empty() {
            return Err(anyhow!("fs store URI has no path: {uri:?}"));
        }
        return ChunkStore::open_fs(path)
            .with_context(|| format!("opening fs chunk store at {path:?}"));
    }

    if let Some(rest) = uri.strip_prefix("s3://") {
        return open_s3(rest);
    }

    Err(anyhow!(
        "unsupported MARI_STORE scheme in {uri:?} (expected fs:// or s3://)"
    ))
}

#[cfg(feature = "s3")]
fn open_s3(rest: &str) -> Result<ChunkStore> {
    // s3://bucket/root/path ; region from AWS_REGION (default us-east-1);
    // endpoint from AWS_ENDPOINT_URL if present (for MinIO / R2).
    let (bucket, root) = match rest.split_once('/') {
        Some((b, r)) => (b, format!("/{r}")),
        None => (rest, "/".to_string()),
    };
    if bucket.is_empty() {
        return Err(anyhow!("s3 store URI has no bucket: s3://{rest}"));
    }
    let region = std::env::var("AWS_REGION").unwrap_or_else(|_| "us-east-1".to_string());
    let endpoint = std::env::var("AWS_ENDPOINT_URL").ok();
    ChunkStore::open_s3(bucket, &region, &root, endpoint.as_deref())
        .with_context(|| format!("opening s3 chunk store s3://{rest}"))
}

#[cfg(not(feature = "s3"))]
fn open_s3(rest: &str) -> Result<ChunkStore> {
    Err(anyhow!(
        "s3 store requested (s3://{rest}) but marid was built without the `s3` feature"
    ))
}
