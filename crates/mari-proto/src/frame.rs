//! CBOR encoding and the 4-byte length-prefixed framing.
//!
//! Wire framing is a big-endian `u32` byte length followed by that many bytes
//! of CBOR body (decisions.md: "framed CBOR over WebSocket"). The same framing
//! is implemented byte-for-byte in `packages/shared` (`src/frame.ts`).

use serde::{Serialize, de::DeserializeOwned};

/// Maximum accepted frame body length: 64 MiB. A larger declared length is
/// rejected before allocation to bound memory from a hostile or corrupt peer.
pub const MAX_FRAME_LEN: u32 = 64 * 1024 * 1024;

/// Errors from encoding, decoding, or framing protocol values.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// CBOR serialization failed.
    #[error("cbor encode error: {0}")]
    Encode(String),
    /// CBOR deserialization failed.
    #[error("cbor decode error: {0}")]
    Decode(String),
    /// A frame's declared body length exceeds [`MAX_FRAME_LEN`].
    #[error("frame length {len} exceeds maximum {max}")]
    FrameTooLarge {
        /// The declared length.
        len: u32,
        /// The configured maximum ([`MAX_FRAME_LEN`]).
        max: u32,
    },
    /// A frame buffer was shorter than its length prefix or declared body.
    #[error("truncated frame: need {need} bytes, have {have}")]
    Truncated {
        /// Bytes required to complete the frame.
        need: usize,
        /// Bytes actually available.
        have: usize,
    },
}

/// Serialize a value to CBOR bytes (no length prefix).
pub fn to_cbor<T: Serialize>(value: &T) -> Result<Vec<u8>, Error> {
    let mut out = Vec::new();
    ciborium::into_writer(value, &mut out).map_err(|e| Error::Encode(e.to_string()))?;
    Ok(out)
}

/// Deserialize a value from CBOR bytes (no length prefix).
pub fn from_cbor<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, Error> {
    ciborium::from_reader(bytes).map_err(|e| Error::Decode(e.to_string()))
}

/// Encode a value as one length-prefixed frame: 4-byte big-endian body length
/// followed by the CBOR body.
pub fn encode_frame<T: Serialize>(value: &T) -> Result<Vec<u8>, Error> {
    let body = to_cbor(value)?;
    let len = u32::try_from(body.len()).map_err(|_| Error::FrameTooLarge {
        len: u32::MAX,
        max: MAX_FRAME_LEN,
    })?;
    if len > MAX_FRAME_LEN {
        return Err(Error::FrameTooLarge {
            len,
            max: MAX_FRAME_LEN,
        });
    }
    let mut framed = Vec::with_capacity(4 + body.len());
    framed.extend_from_slice(&len.to_be_bytes());
    framed.extend_from_slice(&body);
    Ok(framed)
}

/// Decode exactly one length-prefixed frame from `frame`, which must contain
/// the 4-byte prefix and at least the declared number of body bytes.
pub fn decode_frame<T: DeserializeOwned>(frame: &[u8]) -> Result<T, Error> {
    if frame.len() < 4 {
        return Err(Error::Truncated {
            need: 4,
            have: frame.len(),
        });
    }
    let len = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]);
    if len > MAX_FRAME_LEN {
        return Err(Error::FrameTooLarge {
            len,
            max: MAX_FRAME_LEN,
        });
    }
    let total = 4 + len as usize;
    if frame.len() < total {
        return Err(Error::Truncated {
            need: total,
            have: frame.len(),
        });
    }
    from_cbor(&frame[4..total])
}

/// Incremental reader for a byte stream carrying back-to-back length-prefixed
/// frames. Feed bytes with [`FrameReader::push`] as they arrive, then drain
/// complete frames with [`FrameReader::next_body`] / [`FrameReader::next`].
///
/// Mirrors `FrameReader` in `packages/shared/src/frame.ts`.
#[derive(Debug, Default)]
pub struct FrameReader {
    buf: Vec<u8>,
}

impl FrameReader {
    /// A new, empty reader.
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// Append newly received bytes.
    pub fn push(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
    }

    /// Return the next complete CBOR body (without its length prefix), or
    /// `None` if a full frame has not yet arrived. Consumes the frame from the
    /// internal buffer.
    pub fn next_body(&mut self) -> Result<Option<Vec<u8>>, Error> {
        if self.buf.len() < 4 {
            return Ok(None);
        }
        let len = u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]);
        if len > MAX_FRAME_LEN {
            return Err(Error::FrameTooLarge {
                len,
                max: MAX_FRAME_LEN,
            });
        }
        let total = 4 + len as usize;
        if self.buf.len() < total {
            return Ok(None);
        }
        let body = self.buf[4..total].to_vec();
        self.buf.drain(..total);
        Ok(Some(body))
    }

    /// Decode the next complete frame into `T`, or `None` if incomplete.
    // Not `Iterator::next`, and cannot be: the item type is chosen per CALL
    // (each frame is deserialized into whatever the caller expects at that point
    // in the protocol), and it is fallible. An `Iterator` impl would have to fix
    // one item type for the whole reader.
    #[allow(clippy::should_implement_trait)]
    pub fn next<T: DeserializeOwned>(&mut self) -> Result<Option<T>, Error> {
        match self.next_body()? {
            Some(body) => Ok(Some(from_cbor(&body)?)),
            None => Ok(None),
        }
    }

    /// Bytes buffered but not yet forming a complete frame.
    pub fn buffered(&self) -> usize {
        self.buf.len()
    }
}
