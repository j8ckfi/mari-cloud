//! The storage inversion: chunking, manifests, stores, restore, GC.
//!
//! One implementation, used natively by `marid` and (later) compiled to Wasm
//! for the control plane. Drift in this layer is the deletes-a-computer class
//! of bug; there is exactly one copy of this logic.
