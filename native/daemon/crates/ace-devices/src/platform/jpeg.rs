// SPDX-License-Identifier: Apache-2.0
//! `jpeg.ts`: the bounded JPEG splitter and the marker-only checks the device captures use.
//! The Android emulator's screen helper sends a stream of JPEGs; each is handed on whole, with
//! its size read from the frame header, and a picture cut short anywhere is refused rather than
//! decoded (Bun's decoder would fill it with grey).

use crate::platform::{Error, Refusal};

/// The most one JPEG may hold, across the chunks it arrives in.
pub const MAX_FRAME: usize = 8 * 1024 * 1024;

/// The end-of-image marker that closes a JPEG.
const END_MARKER: [u8; 2] = [0xff, 0xd9];

/// Bounded geometric accumulation; emitted bytes are borrowed until `emit` returns.
pub struct JpegDecoder<F> {
    buffer: Vec<u8>,
    size: usize,
    previous: u8,
    emit: F,
}

impl<F: FnMut(&[u8], u32, u32)> JpegDecoder<F> {
    pub fn new(emit: F) -> Self {
        Self {
            buffer: vec![0; 65536],
            size: 0,
            previous: 0,
            emit,
        }
    }

    /// Adds one chunk and emits every whole JPEG it completed, in stream order.
    pub fn push(&mut self, chunk: &[u8]) -> Result<(), Error> {
        let mut start = 0usize;
        let mut end = if self.previous == 0xff && chunk.first() == Some(&0xd9) {
            1
        } else {
            0
        };
        while start < chunk.len() {
            if end == 0 {
                match find_end_marker(chunk, start) {
                    Some(found) => end = found + 2,
                    None => break,
                }
            }
            self.append(&chunk[start..end])?;
            let size = self.size;
            self.size = 0;
            let (width, height) = jpeg_dimensions(&self.buffer[..size])?;
            (self.emit)(&self.buffer[..size], width, height);
            start = end;
            end = 0;
        }
        self.append(&chunk[start..])?;
        if let Some(last) = chunk.last() {
            self.previous = *last;
        }
        Ok(())
    }

    fn append(&mut self, chunk: &[u8]) -> Result<(), Error> {
        let next = self.size + chunk.len();
        if next > MAX_FRAME {
            return Err(Refusal::word("jpegTooLarge").into());
        }
        if next > self.buffer.len() {
            let grown = MAX_FRAME.min(next.max(self.buffer.len() * 2));
            let mut buffer = vec![0; grown];
            buffer[..self.size].copy_from_slice(&self.buffer[..self.size]);
            self.buffer = buffer;
        }
        self.buffer[self.size..next].copy_from_slice(chunk);
        self.size = next;
        Ok(())
    }
}

/// The first end-of-image marker at or after `from`.
fn find_end_marker(chunk: &[u8], from: usize) -> Option<usize> {
    if chunk.len() < 2 {
        return None;
    }
    (from..=chunk.len() - 2).find(|&at| chunk[at..at + 2] == END_MARKER)
}

/// The picture's size from its first frame header (baseline or progressive).
pub fn jpeg_dimensions(image: &[u8]) -> Result<(u32, u32), Error> {
    if image.len() < 2 || image[0..2] != [0xff, 0xd8] {
        return Err(invalid("Invalid JPEG start"));
    }
    let mut at = 2usize;
    while at + 4 <= image.len() {
        if image[at] != 0xff {
            return Err(invalid("Invalid JPEG marker"));
        }
        let marker = image[at + 1];
        if marker == 0xff {
            at += 1;
            continue;
        }
        let length = usize::from(u16::from_be_bytes([image[at + 2], image[at + 3]]));
        if length < 2 || at + 2 + length > image.len() {
            return Err(invalid("Invalid JPEG segment"));
        }
        if marker == 192 || marker == 194 {
            if length < 8 {
                return Err(invalid("Invalid JPEG dimensions"));
            }
            return Ok((
                u32::from(u16::from_be_bytes([image[at + 7], image[at + 8]])),
                u32::from(u16::from_be_bytes([image[at + 5], image[at + 6]])),
            ));
        }
        at += 2 + length;
    }
    Err(invalid("Missing JPEG dimensions"))
}

/// Whether a JPEG is whole: every segment fits, a frame header comes before the first scan, and
/// the last scan's data runs up to the end-of-image marker that closes the bytes. A picture cut
/// short anywhere fails. It reads markers only, never the coded data, so a scan damaged inside
/// while its end marker survives still passes; only a strict decoder could tell.
pub fn jpeg_complete(image: &[u8]) -> bool {
    if image.len() < 4 || image[0] != 0xff || image[1] != 0xd8 {
        return false;
    }
    let mut frame = false;
    let mut scans = 0usize;
    let mut at = 2usize;
    while at + 1 < image.len() {
        if image[at] != 0xff {
            return false;
        }
        let marker = image[at + 1];
        if marker == 0xff {
            at += 1;
            continue;
        }
        if marker == 0xd9 {
            return scans > 0 && at + 2 == image.len();
        }
        if at + 4 > image.len() {
            return false;
        }
        let length = (usize::from(image[at + 2]) << 8) | usize::from(image[at + 3]);
        if length < 2 || at + 2 + length > image.len() {
            return false;
        }
        // Frame headers: baseline, extended, progressive and lossless, Huffman or arithmetic.
        if (0xc0..=0xcf).contains(&marker) && marker != 0xc4 && marker != 0xc8 && marker != 0xcc {
            frame = true;
        }
        at += 2 + length;
        if marker != 0xda {
            continue;
        }
        if !frame {
            return false;
        }
        scans += 1;
        // Coded data ends at the first marker that is neither a stuffed 0xFF nor a restart.
        loop {
            match image[at..].iter().position(|byte| *byte == 0xff) {
                Some(found) if at + found + 1 < image.len() => at += found,
                _ => return false,
            }
            let next = image[at + 1];
            if next == 0x00 || (0xd0..=0xd7).contains(&next) {
                at += 2;
            } else if next == 0xff {
                at += 1;
            } else {
                break;
            }
        }
    }
    false
}

fn invalid(message: &str) -> Error {
    Error::Invalid(message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::Code;

    /// A 20x10 baseline JPEG: APP0, a frame header, one scan and its end marker.
    fn tiny() -> Vec<u8> {
        let mut out = vec![0xff, 0xd8];
        out.extend([0xff, 0xe0, 0x00, 0x04, b'A', b'B']);
        out.extend([0xff, 0xc0, 0x00, 0x0b, 8, 0, 10, 0, 20, 1, 1, 0x11, 0]);
        out.extend([0xff, 0xda, 0x00, 0x04, 0, 0]);
        out.extend([1, 2, 3]);
        out.extend(END_MARKER);
        out
    }

    #[test]
    fn a_jpeg_split_anywhere_still_comes_out_whole_with_its_header_size() {
        let image = tiny();
        for split in 1..image.len() {
            let mut seen = Vec::new();
            let mut decoder = JpegDecoder::new(|bytes: &[u8], width: u32, height: u32| {
                seen.push((bytes.to_vec(), width, height));
            });
            decoder.push(&image[..split]).expect("reads");
            decoder.push(&image[split..]).expect("reads");
            drop(decoder);
            assert_eq!(seen, vec![(image.clone(), 20, 10)], "split at {split}");
        }
    }

    #[test]
    fn two_pictures_in_one_chunk_are_emitted_in_order_and_stray_bytes_are_kept_for_the_next() {
        let image = tiny();
        let mut chunk = image.clone();
        chunk.extend(&image);
        chunk.extend([0xff, 0xd8]);
        let mut seen = Vec::new();
        let mut decoder = JpegDecoder::new(|bytes: &[u8], width: u32, height: u32| {
            seen.push((bytes.len(), width, height));
        });
        decoder.push(&chunk).expect("reads");
        assert!(
            decoder.push(&[0xff, 0xd9]).is_err(),
            "a bare start and end marker is not a picture"
        );
        drop(decoder);
        assert_eq!(seen, vec![(image.len(), 20, 10), (image.len(), 20, 10)]);
    }

    #[test]
    fn a_picture_over_the_cap_is_refused_with_the_protocols_limit_code() {
        let mut decoder = JpegDecoder::new(|_: &[u8], _: u32, _: u32| {});
        let error = decoder.push(&vec![0; MAX_FRAME + 1]).expect_err("refused");
        match error {
            Error::Refused(refusal) => {
                assert_eq!(refusal.code, Code::Limit);
                assert_eq!(refusal.message, "Android JPEG exceeds 8 MiB");
                assert_eq!(refusal.hint, "Reduce emulator resolution.");
            }
            other => panic!("unexpected error: {other}"),
        }
    }

    #[test]
    fn a_picture_is_complete_only_when_its_last_scan_reaches_the_end_marker() {
        let image = tiny();
        assert!(jpeg_complete(&image));
        assert!(!jpeg_complete(&image[..image.len() - 2]));
        let mut stray = image.clone();
        stray.extend([0, 0]);
        assert!(!jpeg_complete(&stray));
        // A scan before any frame header is not a picture.
        let mut scan_first = vec![0xff, 0xd8];
        scan_first.extend([0xff, 0xda, 0x00, 0x04, 0, 0, 9, 0xff, 0xd9]);
        assert!(!jpeg_complete(&scan_first));
        assert!(jpeg_dimensions(&image).is_ok());
    }
}
