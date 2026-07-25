//! Dial the probe Worker with marid's real stack and exchange real frames.
use futures_util::{SinkExt, StreamExt};
use mari_proto::{ControlMessage, SupervisorMessage};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    #[cfg(feature = "tls")]
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("install rustls provider");
    let url = std::env::args().nth(1).expect("url");
    let hello: Vec<u8> = std::fs::read("../fixtures/sup_hello.frame")?;
    let expect: Vec<u8> = std::fs::read("../fixtures/ctl_start_run.frame")?;

    println!("dialing {url}");
    let (mut ws, resp) = match connect_async(url.as_str()).await {
        Ok(v) => v,
        Err(e) => {
            println!("CONNECT-ERROR: {e}");
            println!("CONNECT-ERROR-DEBUG: {e:?}");
            std::process::exit(2);
        }
    };
    println!("connected, status {}", resp.status());

    // Round-trip the real frames.
    ws.send(Message::binary(hello.clone())).await?;
    let msg = ws.next().await.expect("reply")?;
    let got = msg.into_data().to_vec();
    println!("sent {} bytes, got {} bytes", hello.len(), got.len());
    println!("BYTE-EXACT: {}", got == expect);

    // And that both directions decode as real protocol values.
    let sup: SupervisorMessage = mari_proto::decode_frame(&hello)?;
    let ctl: ControlMessage = mari_proto::decode_frame(&got)?;
    println!("decoded sup={sup:?}");
    println!("decoded ctl={ctl:?}");
    ws.close(None).await.ok();
    Ok(())
}
