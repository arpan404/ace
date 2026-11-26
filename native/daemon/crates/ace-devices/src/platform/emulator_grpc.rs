// SPDX-License-Identifier: Apache-2.0
//! `emulator-grpc.ts`: the one Android emulator gRPC call ace makes
//! (`EmulatorController.streamScreenshot`, pixels through shared memory), with only the fields
//! ace uses. The message layouts follow the emulator's published interface; unknown fields are
//! skipped, never fatal. The HTTP/2 connection, its headers and the shared file are the shell's;
//! this decides the request bytes, the framing of each reply and what a reply says.
//!
//! The request's handle is the frame file's URL exactly as the TypeScript spells it
//! (`pathToFileURL(file).href`): a Rust URL builder that spells a path differently would map a
//! different file, so the shell builds the URL and this only encodes it.

/// A reply larger than this is not a frame notice: the stream is refused.
pub const MESSAGE_LIMIT: usize = 64 * 1024;

/// `ImageFormat.ImgFormat.RGBA8888` and `ImageTransport.TransportChannel.MMAP`.
const RGBA_8888: u32 = 1;
const MMAP: u32 = 1;

/// The emulator controller's method ace calls.
pub const SCREENSHOT_PATH: &str = "/android.emulation.control.EmulatorController/streamScreenshot";

/// What one reply said about the picture the emulator wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenNotice {
    pub seq: u64,
    pub width: u64,
    pub height: u64,
    pub timestamp_us: u64,
}

/// Why a reply is not a frame notice, or the stream cannot go on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum FrameError {
    #[error("Truncated emulator message")]
    Truncated,
    #[error("Unknown emulator wire type")]
    UnknownWire,
    #[error("Compressed emulator message")]
    Compressed,
    #[error("Emulator message exceeds limit")]
    ExceedsLimit,
}

/// A protobuf varint, as the TypeScript's `varint` writes one.
fn varint(mut value: u64) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(10);
    while value > 0x7f {
        bytes.push((value as u8 & 0x7f) | 0x80);
        value /= 128;
    }
    bytes.push(value as u8);
    bytes
}

/// A length-delimited field: its tag, the length, then its bytes.
fn length_delimited(field: u32, bytes: &[u8]) -> Vec<u8> {
    let mut out = varint(u64::from(field << 3 | 2));
    out.extend(varint(bytes.len() as u64));
    out.extend_from_slice(bytes);
    out
}

/// The `screenshotRequest` ace sends: RGBA8888 pictures that fit `width` × `height` (the
/// emulator keeps the aspect ratio and never upscales), written into the shared file the handle
/// names.
pub fn screenshot_request(width: u32, height: u32, handle: &str) -> Vec<u8> {
    let mut transport = vec![0x08, MMAP as u8];
    transport.extend(length_delimited(2, handle.as_bytes()));
    let mut out = vec![0x08, RGBA_8888 as u8, 0x18];
    out.extend(varint(u64::from(width)));
    out.push(0x20);
    out.extend(varint(u64::from(height)));
    out.extend(length_delimited(6, &transport));
    out
}

/// A gRPC frame: the compression flag (0), the 4-byte big-endian length, then the message.
pub fn grpc_frame(message: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(5 + message.len());
    frame.push(0);
    frame.extend((message.len() as u32).to_be_bytes());
    frame.extend_from_slice(message);
    frame
}

/// One field's varint value or length-delimited bytes; a repeated field keeps its last value.
/// A varint wider than 64 bits is refused before its tag or length is read: the TypeScript's
/// number arithmetic overflows past the message and reports it truncated, never empty.
fn fields(message: &[u8]) -> Result<std::collections::HashMap<u32, Field<'_>>, FrameError> {
    let mut out = std::collections::HashMap::new();
    let mut offset = 0usize;
    let read = |offset: &mut usize| -> Result<u64, FrameError> {
        let mut value: u64 = 0;
        let mut shift: u32 = 0;
        loop {
            let byte = *message.get(*offset).ok_or(FrameError::Truncated)?;
            *offset += 1;
            let bits = u64::from(byte & 0x7f);
            // The tenth byte carries one bit (bit 63); anything more does not fit.
            if shift > 63 || (shift == 63 && bits > 1) {
                return Err(FrameError::Truncated);
            }
            value |= bits << shift;
            if byte < 0x80 {
                return Ok(value);
            }
            shift += 7;
        }
    };
    while offset < message.len() {
        let tag = read(&mut offset)?;
        let field = (tag / 8).min(u64::from(u32::MAX)) as u32;
        match tag & 7 {
            0 => {
                let value = read(&mut offset)?;
                out.insert(field, Field::Number(value));
            }
            2 => {
                let length = read(&mut offset)? as usize;
                let end = offset.checked_add(length).ok_or(FrameError::Truncated)?;
                let bytes = message.get(offset..end).ok_or(FrameError::Truncated)?;
                out.insert(field, Field::Bytes(bytes));
                offset = end;
            }
            1 => offset = offset.checked_add(8).ok_or(FrameError::Truncated)?,
            5 => offset = offset.checked_add(4).ok_or(FrameError::Truncated)?,
            _ => return Err(FrameError::UnknownWire),
        }
    }
    Ok(out)
}

/// One field's value in a decoded message.
#[derive(Debug, Clone, Copy)]
enum Field<'a> {
    Number(u64),
    Bytes(&'a [u8]),
}

/// The number a field holds, or 0 when it is absent or another wire type (the TypeScript's
/// `number()`).
fn number(field: Option<&Field<'_>>) -> u64 {
    match field {
        Some(Field::Number(value)) => *value,
        _ => 0,
    }
}

/// An `Image` reply as a notice; width and height are 0 when the display is off.
pub fn screen_notice(message: &[u8]) -> Result<ScreenNotice, FrameError> {
    let image = fields(message)?;
    let size = match image.get(&1) {
        Some(Field::Bytes(bytes)) => fields(bytes)?,
        _ => std::collections::HashMap::new(),
    };
    Ok(ScreenNotice {
        seq: number(image.get(&5)),
        width: number(size.get(&3)),
        height: number(size.get(&4)),
        timestamp_us: number(image.get(&6)),
    })
}

/// The connection's framing: a compression flag and a 4-byte length before each message.
#[derive(Debug, Default)]
pub struct Frames {
    pending: Vec<u8>,
}

impl Frames {
    pub fn new() -> Self {
        Self::default()
    }

    /// Takes one chunk and hands every complete message to `emit`. A compressed message, or one
    /// over the limit, refuses the stream before anything is decoded.
    pub fn push(&mut self, chunk: &[u8], emit: &mut impl FnMut(&[u8])) -> Result<(), FrameError> {
        self.pending.extend_from_slice(chunk);
        let mut at = 0usize;
        loop {
            let rest = &self.pending[at..];
            if rest.len() < 5 {
                break;
            }
            if rest[0] != 0 {
                return Err(FrameError::Compressed);
            }
            let length = u32::from_be_bytes([rest[1], rest[2], rest[3], rest[4]]) as usize;
            if length > MESSAGE_LIMIT {
                return Err(FrameError::ExceedsLimit);
            }
            if rest.len() < 5 + length {
                break;
            }
            emit(&rest[5..5 + length]);
            at += 5 + length;
        }
        self.pending.drain(..at);
        Ok(())
    }
}

/// What a `grpc-status` refuses the stream with, or `None` for a status that is fine.
pub fn status_refusal(status: &str) -> Option<String> {
    if status.is_empty() || status == "0" {
        return None;
    }
    Some(format!("Emulator screen stream refused (gRPC {status})"))
}

/// What a stream that ended on its own reports.
pub fn stream_ended() -> &'static str {
    "Emulator screen stream ended"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_names_rgba_the_box_and_the_handle_exactly_as_given() {
        // ImageFormat{RGBA8888, width: 5, height: 300}, transport MMAP with the handle "f".
        let bytes = screenshot_request(5, 300, "f");
        assert_eq!(
            bytes,
            vec![
                0x08, 1, // format = RGBA8888
                0x18, 5, // width
                0x20, 0xac, 0x02, // height 300
                0x32, 5, // transport, 5 bytes
                0x08, 1, // MMAP
                0x12, 1, b'f', // the handle
            ]
        );
    }

    #[test]
    fn a_long_handle_is_length_prefixed_in_utf8_bytes() {
        let handle = "file:///Users/me/Library/f.rgba";
        let bytes = screenshot_request(1080, 2400, handle);
        assert_eq!(&bytes[bytes.len() - handle.len()..], handle.as_bytes());
        assert_eq!(bytes[bytes.len() - handle.len() - 1], handle.len() as u8);
    }

    #[test]
    fn a_windows_file_url_keeps_its_own_spelling() {
        let handle = "file:///C:/Users/me/AppData/f.rgba";
        let bytes = screenshot_request(64, 64, handle);
        assert_eq!(&bytes[bytes.len() - handle.len()..], handle.as_bytes());
    }

    #[test]
    fn a_frame_is_the_flag_the_length_then_the_message() {
        assert_eq!(grpc_frame(&[1, 2, 3]), vec![0, 0, 0, 0, 3, 1, 2, 3]);
        assert_eq!(grpc_frame(&[]), vec![0, 0, 0, 0, 0]);
    }

    #[test]
    fn messages_split_across_chunks_and_several_in_one_are_all_read() {
        let mut frames = Frames::new();
        let mut seen: Vec<Vec<u8>> = Vec::new();
        let first = grpc_frame(&[1, 2]);
        let second = grpc_frame(&[3]);
        frames
            .push(&first[..2], &mut |message: &[u8]| {
                seen.push(message.to_vec())
            })
            .expect("partial");
        assert!(seen.is_empty());
        let mut both = first[2..].to_vec();
        both.extend(&second);
        frames
            .push(&both, &mut |message: &[u8]| seen.push(message.to_vec()))
            .expect("the rest");
        assert_eq!(seen, vec![vec![1, 2], vec![3]]);
    }

    #[test]
    fn a_compressed_or_oversized_message_refuses_the_stream() {
        let mut frames = Frames::new();
        let mut emit = |_: &[u8]| {};
        assert_eq!(
            frames.push(&[1, 0, 0, 0, 0], &mut emit),
            Err(FrameError::Compressed)
        );
        let mut frames = Frames::new();
        let big = (MESSAGE_LIMIT as u32 + 1).to_be_bytes();
        assert_eq!(
            frames.push(&[0, big[0], big[1], big[2], big[3]], &mut emit),
            Err(FrameError::ExceedsLimit)
        );
    }

    #[test]
    fn a_notice_reads_the_sequence_the_size_and_the_capture_time() {
        // Image{format: ImageFormat{width: 1080, height: 2400}, seq: 7, timestamp_us: 900}
        let mut format = vec![0x18];
        format.extend(varint(1080));
        format.push(0x20);
        format.extend(varint(2400));
        let mut image = length_delimited(1, &format);
        image.push(0x28);
        image.extend(varint(7));
        image.push(0x30);
        image.extend(varint(900));
        assert_eq!(
            screen_notice(&image).expect("a notice"),
            ScreenNotice {
                seq: 7,
                width: 1080,
                height: 2400,
                timestamp_us: 900,
            }
        );
    }

    #[test]
    fn a_display_that_is_off_is_a_notice_of_size_zero() {
        let notice = screen_notice(&length_delimited(5, b"")).expect("a notice");
        assert_eq!((notice.width, notice.height), (0, 0));
    }

    #[test]
    fn unknown_fields_are_skipped_and_a_broken_message_is_refused() {
        // An unknown fixed64 (field 9), fixed32 (field 10) and varint (field 11).
        let mut message = vec![0x08, 1];
        message.extend([0x49, 0, 0, 0, 0, 0, 0, 0, 0]);
        message.extend([0x55, 0, 0, 0, 0]);
        message.extend([0x58, 5]);
        assert_eq!(
            screen_notice(&message).expect("skipped").seq,
            0,
            "only known fields are read"
        );
        assert_eq!(
            screen_notice(&[0x08]),
            Err(FrameError::Truncated),
            "a varint with no byte is truncated"
        );
        assert_eq!(
            screen_notice(&[0x0b]),
            Err(FrameError::UnknownWire),
            "wire type 3 is not read"
        );
        assert_eq!(
            screen_notice(&[0x0a, 5, 1]),
            Err(FrameError::Truncated),
            "a length past the end is truncated"
        );
    }

    #[test]
    fn a_varint_wider_than_64_bits_is_refused_before_any_tag_or_length_is_read() {
        // A length of 2^64: 0x0a (field 1, length-delimited) then the overflowing varint.
        let mut length = vec![0x0a];
        length.extend([0x80; 9]);
        length.push(0x02);
        assert_eq!(
            screen_notice(&length),
            Err(FrameError::Truncated),
            "a length of 2^64 is not an empty message"
        );
        // A tag of 2^64 is refused the same way, before its wire type is looked at.
        let mut tag = vec![0x80; 9];
        tag.push(0x02);
        assert_eq!(screen_notice(&tag), Err(FrameError::Truncated));
        // The largest 64-bit value still reads as one.
        let mut largest = vec![0x30];
        largest.extend([0xff; 9]);
        largest.push(0x01);
        assert_eq!(
            screen_notice(&largest)
                .expect("a bounded varint")
                .timestamp_us,
            u64::MAX
        );
    }

    #[test]
    fn a_non_zero_status_refuses_the_stream_and_zero_does_not() {
        assert_eq!(status_refusal("0"), None);
        assert_eq!(status_refusal(""), None);
        assert_eq!(
            status_refusal("14").as_deref(),
            Some("Emulator screen stream refused (gRPC 14)")
        );
        assert_eq!(stream_ended(), "Emulator screen stream ended");
    }
}
