//! WebSocket transport helpers: framed-CBOR send/recv and reconnect backoff.
//!
//! The supervisor <-> control-plane stream carries back-to-back length-prefixed
//! CBOR frames (contracts §2), even over a WebSocket: each binary message
//! payload is one [`mari_proto::encode_frame`] frame. Incoming payloads are fed
//! through a [`mari_proto::FrameReader`] so a message split or coalesced by the
//! transport still decodes into whole protocol values.

use std::time::Duration;

use anyhow::Result;
use futures_util::SinkExt;
use mari_proto::{FrameReader, encode_frame, from_cbor};
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio_tungstenite::tungstenite::Message;

/// Encode a protocol value as one length-prefixed frame and send it as a binary
/// WebSocket message.
pub async fn send_framed<S, T>(sink: &mut S, value: &T) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
    T: Serialize,
{
    let frame = encode_frame(value)?;
    sink.send(Message::binary(frame)).await?;
    Ok(())
}

/// Decode every complete protocol value contained in an incoming binary
/// message's payload (usually exactly one), appending them to `out`.
pub fn decode_payload<T: DeserializeOwned>(
    reader: &mut FrameReader,
    payload: &[u8],
    out: &mut Vec<T>,
) -> Result<()> {
    reader.push(payload);
    while let Some(body) = reader.next_body()? {
        out.push(from_cbor::<T>(&body)?);
    }
    Ok(())
}

/// Exponential reconnect backoff with a cap, reset on a successful connection.
#[derive(Clone, Debug)]
pub struct Backoff {
    current: Duration,
    initial: Duration,
    max: Duration,
}

impl Backoff {
    /// A backoff from `initial`, doubling up to `max`.
    pub fn new(initial: Duration, max: Duration) -> Self {
        Self {
            current: initial,
            initial,
            max,
        }
    }

    /// The delay to wait before the next reconnect attempt, then double it
    /// (saturating at `max`).
    pub fn next_delay(&mut self) -> Duration {
        let d = self.current;
        self.current = (self.current * 2).min(self.max);
        d
    }

    /// Reset to the initial delay after a successful connection.
    pub fn reset(&mut self) {
        self.current = self.initial;
    }
}

impl Default for Backoff {
    fn default() -> Self {
        Backoff::new(Duration::from_millis(100), Duration::from_secs(5))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_and_caps_then_resets() {
        let mut b = Backoff::new(Duration::from_millis(100), Duration::from_millis(800));
        assert_eq!(b.next_delay(), Duration::from_millis(100));
        assert_eq!(b.next_delay(), Duration::from_millis(200));
        assert_eq!(b.next_delay(), Duration::from_millis(400));
        assert_eq!(b.next_delay(), Duration::from_millis(800));
        assert_eq!(b.next_delay(), Duration::from_millis(800));
        b.reset();
        assert_eq!(b.next_delay(), Duration::from_millis(100));
    }
}
