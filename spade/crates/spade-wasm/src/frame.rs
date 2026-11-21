//! Framed messages on the pipe: a 4-byte big-endian length, then that many bytes of JSON. A frame
//! is at most [`MOST_FRAME`] bytes; a longer one, or one that doesn't parse, is an error that
//! ends the pipe. The worker reads and writes blocking; Spade, on tokio.

use std::io::{self, Read, Write};

use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// The largest frame either side sends: a call's input or output, or a request's body.
pub const MOST_FRAME: usize = 16 * 1024 * 1024;

fn too_long(len: usize) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("a frame of {len} bytes is over the pipe's {MOST_FRAME}"),
    )
}

fn encode(message: &impl Serialize) -> io::Result<Vec<u8>> {
    let body = serde_json::to_vec(message).map_err(io::Error::other)?;
    let len = u32::try_from(body.len())
        .ok()
        .filter(|len| *len as usize <= MOST_FRAME)
        .ok_or_else(|| too_long(body.len()))?;
    let mut frame = Vec::with_capacity(body.len() + 4);
    frame.extend_from_slice(&len.to_be_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

fn decode<T: DeserializeOwned>(body: &[u8]) -> io::Result<T> {
    serde_json::from_slice(body).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

fn length(head: [u8; 4]) -> io::Result<usize> {
    let len = u32::from_be_bytes(head) as usize;
    if len > MOST_FRAME {
        return Err(too_long(len));
    }
    Ok(len)
}

/// Writes one frame and flushes it.
pub fn write(out: &mut impl Write, message: &impl Serialize) -> io::Result<()> {
    out.write_all(&encode(message)?)?;
    out.flush()
}

/// Reads one frame; `None` when the pipe closed between frames.
pub fn read<T: DeserializeOwned>(input: &mut impl Read) -> io::Result<Option<T>> {
    let mut head = [0u8; 4];
    match input.read_exact(&mut head) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let mut body = vec![0u8; length(head)?];
    input.read_exact(&mut body)?;
    decode(&body).map(Some)
}

/// Writes one frame and flushes it.
pub async fn write_async(
    out: &mut (impl AsyncWrite + Unpin),
    message: &impl Serialize,
) -> io::Result<()> {
    out.write_all(&encode(message)?).await?;
    out.flush().await
}

/// Reads one frame; `None` when the pipe closed between frames.
pub async fn read_async<T: DeserializeOwned>(
    input: &mut (impl AsyncRead + Unpin),
) -> io::Result<Option<T>> {
    let mut head = [0u8; 4];
    match input.read_exact(&mut head).await {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let mut body = vec![0u8; length(head)?];
    input.read_exact(&mut body).await?;
    decode(&body).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ToWorker;

    #[test]
    fn a_frame_reads_back_as_it_was_written() {
        let stop = ToWorker::Stop { id: Some(7) };
        let mut pipe = Vec::new();
        write(&mut pipe, &stop).unwrap_or_else(|e| panic!("{e}"));
        let back: Option<ToWorker> = read(&mut pipe.as_slice()).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(back, Some(stop));
        let closed: Option<ToWorker> = read(&mut [].as_slice()).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(closed, None);
    }

    #[test]
    fn a_frame_longer_than_the_bound_is_refused_before_its_body_is_read() {
        let mut pipe = u32::try_from(MOST_FRAME + 1)
            .unwrap_or(u32::MAX)
            .to_be_bytes()
            .to_vec();
        pipe.extend_from_slice(b"{}");
        let refused = read::<ToWorker>(&mut pipe.as_slice());
        assert!(refused.is_err_and(|e| e.kind() == io::ErrorKind::InvalidData));
    }
}
