//! Wire protocol types shared between `marid` and the control plane.
//!
//! Every message that crosses the supervisor <-> control plane WebSocket is
//! defined here, serialized as CBOR. `packages/shared` mirrors these types in
//! TypeScript; conformance fixtures keep the two from drifting.
