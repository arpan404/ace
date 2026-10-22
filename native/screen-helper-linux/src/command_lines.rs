//! Commands from the daemon, one JSON line each on stdin, read on their own task so a `stop`
//! can arrive while a `start` is still waiting for the person in the sharing dialog.
use crate::protocol::{Fault, Request, Result, internal};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::sync::mpsc;

/// Reads requests until end of input or the first malformed one, which ends the stream.
pub fn spawn(input: impl AsyncRead + Unpin + Send + 'static) -> mpsc::Receiver<Result<Request>> {
    let (sender, receiver) = mpsc::channel(64);
    tokio::spawn(async move {
        let mut input = BufReader::new(input);
        loop {
            let line = match read_line(&mut input).await {
                Ok(Some(line)) => line,
                Ok(None) => return,
                Err(error) => {
                    let _ = sender.send(Err(error)).await;
                    return;
                }
            };
            let parsed = Request::parse(&line);
            let failed = parsed.is_err();
            if sender.send(parsed).await.is_err() || failed {
                return;
            }
        }
    });
    receiver
}

/// One line, at most 64 KiB; `None` at end of input.
async fn read_line(input: &mut (impl AsyncBufReadExt + Unpin)) -> Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    // fill_buf avoids allocating an unbounded command before checking its limit.
    loop {
        let bytes = input.fill_buf().await.map_err(internal)?;
        if bytes.is_empty() {
            return Ok((!line.is_empty()).then_some(line));
        }
        let end = bytes
            .iter()
            .position(|b| *b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(bytes.len());
        if line.len() + end > 64 * 1024 {
            return Err(Fault::new("bounds", "Command exceeds 64 KiB"));
        }
        let newline = bytes[end - 1] == b'\n';
        line.extend_from_slice(&bytes[..end]);
        input.consume(end);
        if newline {
            return Ok(Some(line));
        }
    }
}
