// SPDX-License-Identifier: Apache-2.0
//! Reading and writing whole frames: control frames on the normal and priority lanes, and
//! `MediaFrame`s on ingest connections. Every control frame is read into one wiped buffer of
//! exactly its length, never through a shared buffered reader, so a secret payload has one copy.
use media_wire::control::{ControlFrame, FromMedia, Lane, ToMedia};
use media_wire::frame::MediaFrame;
use std::io;
use tokio::io::{AsyncRead, AsyncReadExt};
use zeroize::Zeroizing;

pub fn lane_limit(lane: Lane) -> usize {
    match lane {
        Lane::Normal => 8 * 1024 * 1024,
        Lane::Priority => 64 * 1024,
    }
}

pub const MEDIA_HEADER_MIN: usize = 44;
pub const MEDIA_HEADER_MAX: usize = 4096;
pub const MEDIA_PAYLOAD_MAX: usize = 8 * 1024 * 1024;

fn invalid(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, what.to_owned())
}

/// Fills `buffer`, or reports a clean end when the stream closed before its first byte.
async fn fill<R: AsyncRead + Unpin>(reader: &mut R, buffer: &mut [u8]) -> io::Result<bool> {
    let mut read = 0;
    while read < buffer.len() {
        let n = reader.read(&mut buffer[read..]).await?;
        if n == 0 {
            return if read == 0 {
                Ok(false)
            } else {
                Err(io::ErrorKind::UnexpectedEof.into())
            };
        }
        read += n;
    }
    Ok(true)
}

/// The next control frame, `None` at a clean end of stream.
pub async fn read_control<R: AsyncRead + Unpin>(
    reader: &mut R,
    lane: Lane,
) -> io::Result<Option<ControlFrame<ToMedia>>> {
    let mut prefix = [0u8; 4];
    if !fill(reader, &mut prefix).await? {
        return Ok(None);
    }
    let length = u32::from_be_bytes(prefix) as usize;
    if !(4..=lane_limit(lane)).contains(&length) {
        return Err(invalid("control frame length"));
    }
    let mut frame = Zeroizing::new(vec![0u8; 4 + length]);
    frame[..4].copy_from_slice(&prefix);
    reader.read_exact(&mut frame[4..]).await?;
    ControlFrame::decode(&frame, lane)
        .map(Some)
        .map_err(|_| invalid("control frame"))
}

/// Encodes a message without payload for `lane`.
pub fn encode(message: FromMedia, lane: Lane) -> io::Result<Vec<u8>> {
    let frame = ControlFrame {
        message,
        payload: Zeroizing::new(Vec::new()),
    };
    frame
        .header(lane)
        .map_err(|_| invalid("outgoing control frame"))
}

/// The next `MediaFrame`, `None` at a clean end of stream.
pub async fn read_media<R: AsyncRead + Unpin>(reader: &mut R) -> io::Result<Option<MediaFrame>> {
    let mut head = [0u8; 12];
    if !fill(reader, &mut head).await? {
        return Ok(None);
    }
    let header = usize::from(u16::from_be_bytes([head[6], head[7]]));
    let payload = u32::from_be_bytes([head[8], head[9], head[10], head[11]]) as usize;
    if &head[..4] != b"ACEM"
        || !(MEDIA_HEADER_MIN..=MEDIA_HEADER_MAX).contains(&header)
        || payload > MEDIA_PAYLOAD_MAX
    {
        return Err(invalid("media frame header"));
    }
    let mut frame = vec![0u8; header + payload];
    frame[..12].copy_from_slice(&head);
    reader.read_exact(&mut frame[12..]).await?;
    MediaFrame::decode(&frame)
        .map(Some)
        .map_err(|_| invalid("media frame"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ping_frame() -> Vec<u8> {
        let json = br#"{"type":"ping","id":"p1"}"#;
        let mut bytes = ((json.len() + 4) as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(&(json.len() as u32).to_be_bytes());
        bytes.extend_from_slice(json);
        bytes
    }

    fn run<T>(future: impl std::future::Future<Output = T>) -> T {
        match tokio::runtime::Builder::new_current_thread().build() {
            Ok(runtime) => runtime.block_on(future),
            Err(error) => panic!("runtime: {error}"),
        }
    }

    #[test]
    fn reads_back_to_back_control_frames_and_a_clean_end() {
        let mut bytes = ping_frame();
        bytes.extend(ping_frame());
        let mut reader = bytes.as_slice();
        run(async {
            for _ in 0..2 {
                let frame = read_control(&mut reader, Lane::Normal).await;
                assert!(matches!(
                    frame,
                    Ok(Some(ControlFrame {
                        message: ToMedia::Ping { .. },
                        ..
                    }))
                ));
            }
            assert!(matches!(
                read_control(&mut reader, Lane::Normal).await,
                Ok(None)
            ));
        });
    }

    #[test]
    fn refuses_frames_over_the_lane_limit_and_cut_off_frames() {
        run(async {
            let huge = ((64 * 1024 + 1) as u32).to_be_bytes();
            let mut reader = huge.as_slice();
            assert!(read_control(&mut reader, Lane::Priority).await.is_err());
            let cut = ping_frame();
            let mut reader = &cut[..cut.len() - 1];
            assert!(read_control(&mut reader, Lane::Normal).await.is_err());
            // A normal-lane message on the priority lane is a protocol error.
            let ping = ping_frame();
            let mut reader = ping.as_slice();
            assert!(read_control(&mut reader, Lane::Priority).await.is_err());
        });
    }

    #[test]
    fn reads_media_frames_and_refuses_bad_magic() {
        let frame = MediaFrame {
            kind: 5,
            flags: 0,
            age_us: 0,
            width: 0,
            height: 0,
            display_width: 0,
            display_height: 0,
            scale: 1000,
            rotation: 0,
            codec: 0,
            encode: 0,
            epoch: 0,
            codec_string: String::new(),
            description: Vec::new(),
            extension: Vec::new(),
            payload: vec![3; 32],
        };
        let Ok(bytes) = frame.encode() else {
            panic!("hello did not encode");
        };
        run(async {
            let mut reader = bytes.as_slice();
            assert!(matches!(read_media(&mut reader).await, Ok(Some(f)) if f == frame));
            let mut bad = bytes.clone();
            bad[0] = b'X';
            let mut reader = bad.as_slice();
            assert!(read_media(&mut reader).await.is_err());
        });
    }
}
