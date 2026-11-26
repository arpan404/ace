// SPDX-License-Identifier: Apache-2.0
//! `mjpeg.ts`: bounded multipart decoding of serve-sim's MJPEG stream. One advertised frame is
//! allocated, never repeatedly joined image chunks; each whole picture comes back with its
//! number, the value [`MjpegDecoder::started`] took when it began arriving.

use crate::platform::Error;

use super::jpeg::jpeg_dimensions;

/// The longest part header, in bytes, before it is refused as malformed.
const HEADER_LIMIT: usize = 4096;
/// The most one advertised picture may hold.
const IMAGE_LIMIT: usize = 8 * 1024 * 1024;

/// One whole picture from the stream, with the number of the part that carried it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MjpegFrame {
    pub image: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub frame: u32,
}

#[derive(Debug)]
pub struct MjpegDecoder {
    header: [u8; HEADER_LIMIT],
    header_bytes: usize,
    image: Option<Vec<u8>>,
    image_bytes: usize,
    frame: u32,
    boundary: String,
    begun: u32,
}

impl MjpegDecoder {
    pub fn new(boundary: &str) -> Result<Self, Error> {
        if !is_valid_boundary(boundary) {
            return Err(invalid("Invalid Simulator multipart boundary"));
        }
        Ok(Self {
            header: [0; HEADER_LIMIT],
            header_bytes: 0,
            image: None,
            image_bytes: 0,
            frame: 0,
            boundary: boundary.to_string(),
            begun: 0,
        })
    }

    /// How many frames have begun arriving: the count rises at the first byte of a part header.
    pub fn started(&self) -> u32 {
        self.begun
    }

    /// Adds one chunk, handing every picture it completed to `frames` in stream order. A
    /// malformed part is the error, but the pictures before it in the same chunk are delivered
    /// first: the TypeScript emits each one as it completes, so a still can still settle.
    pub fn push(&mut self, chunk: &[u8], frames: &mut Vec<MjpegFrame>) -> Result<(), Error> {
        let mut at = 0usize;
        while at < chunk.len() {
            if self.image.is_none() {
                if self.header_bytes == HEADER_LIMIT {
                    return Err(invalid("Simulator JPEG headers exceed limit"));
                }
                let byte = chunk[at];
                at += 1;
                // The line break closing the last image belongs to it, not to the next frame.
                if self.header_bytes == 0 {
                    if byte == 0x0d || byte == 0x0a {
                        continue;
                    }
                    self.begun += 1;
                }
                self.header[self.header_bytes] = byte;
                self.header_bytes += 1;
                if self.header_bytes < 4
                    || self.header[self.header_bytes - 4..self.header_bytes]
                        != [0x0d, 0x0a, 0x0d, 0x0a]
                {
                    continue;
                }
                self.open_part()?;
            }
            if self.image.is_some() {
                let take = self
                    .image
                    .as_ref()
                    .map(|image| (image.len() - self.image_bytes).min(chunk.len() - at))
                    .unwrap_or(0);
                if take > 0 {
                    let Some(image) = self.image.as_mut() else {
                        continue;
                    };
                    image[self.image_bytes..self.image_bytes + take]
                        .copy_from_slice(&chunk[at..at + take]);
                    self.image_bytes += take;
                    at += take;
                }
                if self
                    .image
                    .as_ref()
                    .is_some_and(|image| self.image_bytes < image.len())
                {
                    continue;
                }
                let Some(image) = self.image.take() else {
                    continue;
                };
                self.image_bytes = 0;
                let (width, height) = jpeg_dimensions(&image)?;
                frames.push(MjpegFrame {
                    image,
                    width,
                    height,
                    frame: self.frame,
                });
            }
        }
        Ok(())
    }

    /// Reads a complete part header: its boundary, the picture's length and its content type.
    fn open_part(&mut self) -> Result<(), Error> {
        let text: String = self.header[..self.header_bytes]
            .iter()
            .map(|byte| char::from(*byte & 0x7f))
            .collect();
        let mut lines = text.trim().split("\r\n");
        let expected = format!("--{}", self.boundary);
        if lines.next() != Some(expected.as_str()) {
            return Err(invalid("Invalid Simulator frame boundary"));
        }
        let mut length = None;
        let mut jpeg = false;
        for line in lines {
            let lower = line.to_ascii_lowercase();
            if length.is_none() && lower.starts_with("content-length:") {
                let value = line.split(':').nth(1).map(str::trim).unwrap_or("");
                let digits = (1..=8).contains(&value.len())
                    && value.bytes().all(|byte| byte.is_ascii_digit());
                let bytes = value.parse::<usize>().unwrap_or(0);
                if !digits || !(2..=IMAGE_LIMIT).contains(&bytes) {
                    return Err(invalid("Simulator JPEG size exceeds limit"));
                }
                length = Some(bytes);
            }
            if let Some(rest) = lower.strip_prefix("content-type:")
                && rest.trim_start() == "image/jpeg"
            {
                jpeg = true;
            }
        }
        let Some(length) = length else {
            return Err(invalid("Simulator JPEG size exceeds limit"));
        };
        if !jpeg {
            return Err(invalid("Invalid Simulator frame content type"));
        }
        self.image = Some(vec![0; length]);
        self.image_bytes = 0;
        self.header_bytes = 0;
        self.frame = self.begun;
        Ok(())
    }
}

/// A multipart boundary is 1 to 70 ASCII letters, digits, underscores or dashes.
pub(crate) fn is_valid_boundary(boundary: &str) -> bool {
    (1..=70).contains(&boundary.len())
        && boundary
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn invalid(message: &str) -> Error {
    Error::Invalid(message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 20x10 baseline JPEG: APP0, a frame header, one scan and its end marker.
    fn tiny() -> Vec<u8> {
        let mut out = vec![0xff, 0xd8];
        out.extend([0xff, 0xe0, 0x00, 0x04, b'A', b'B']);
        out.extend([0xff, 0xc0, 0x00, 0x0b, 8, 0, 10, 0, 20, 1, 1, 0x11, 0]);
        out.extend([0xff, 0xda, 0x00, 0x04, 0, 0]);
        out.extend([1, 2, 3]);
        out.extend([0xff, 0xd9]);
        out
    }

    fn part(boundary: &str, image: &[u8]) -> Vec<u8> {
        format!(
            "--{boundary}\r\ncontent-length: {}\r\ncontent-type: image/jpeg\r\n\r\n",
            image.len()
        )
        .into_bytes()
        .into_iter()
        .chain(image.iter().copied())
        .collect()
    }

    #[test]
    fn a_part_split_anywhere_is_emitted_whole_with_its_number_and_size() {
        let image = tiny();
        let stream = part("frame", &image);
        for split in 1..stream.len() {
            let mut decoder = MjpegDecoder::new("frame").expect("valid boundary");
            let mut seen = Vec::new();
            decoder
                .push(&stream[..split], &mut seen)
                .expect("reads the start");
            decoder
                .push(&stream[split..], &mut seen)
                .expect("reads the rest");
            assert_eq!(
                seen,
                vec![MjpegFrame {
                    image: image.clone(),
                    width: 20,
                    height: 10,
                    frame: 1
                }],
                "split at {split}"
            );
            assert_eq!(decoder.started(), 1);
        }
    }

    #[test]
    fn a_whole_picture_before_a_malformed_part_arrives_before_the_error() {
        let image = tiny();
        let mut stream = part("frame", &image);
        stream.extend(b"--frame\r\ncontent-length: 999999999\r\ncontent-type: image/jpeg\r\n\r\n");
        let mut decoder = MjpegDecoder::new("frame").expect("valid boundary");
        let mut seen = Vec::new();
        let error = decoder
            .push(&stream, &mut seen)
            .expect_err("malformed part");
        assert_eq!(
            seen,
            vec![MjpegFrame {
                image,
                width: 20,
                height: 10,
                frame: 1
            }],
            "the picture completed before the bad part"
        );
        assert!(error.to_string().contains("exceeds limit"), "{error}");
    }

    #[test]
    fn two_parts_count_up_and_a_leading_line_break_is_not_a_new_frame() {
        let image = tiny();
        let mut stream = part("frame", &image);
        stream.extend(b"\r\n--frame\r\n");
        stream.extend(b"content-length: 4\r\ncontent-type: image/jpeg\r\n\r\n");
        // A second, four-byte picture body the decoder hands on after reading its size.
        stream.extend([0xff, 0xd8, 0xff, 0xd9]);
        let mut decoder = MjpegDecoder::new("frame").expect("valid boundary");
        let mut seen = Vec::new();
        let error = decoder
            .push(&stream, &mut seen)
            .expect_err("the second body has no frame header");
        assert!(error.to_string().contains("Missing JPEG dimensions"));
        assert_eq!(seen.len(), 1, "the first picture still came");
        assert_eq!(decoder.started(), 2);
    }

    #[test]
    fn a_part_that_names_no_jpeg_or_the_wrong_length_is_refused() {
        let image = tiny();
        for stream in [
            b"--frame\r\ncontent-length: 4\r\ncontent-type: image/png\r\n\r\nabcd".to_vec(),
            b"--frame\r\ncontent-length: 1\r\ncontent-type: image/jpeg\r\n\r\na".to_vec(),
            b"--frame\r\ncontent-length: 999999999\r\ncontent-type: image/jpeg\r\n\r\n".to_vec(),
            b"--other\r\ncontent-length: 4\r\ncontent-type: image/jpeg\r\n\r\nabcd".to_vec(),
        ] {
            let mut decoder = MjpegDecoder::new("frame").expect("valid");
            assert!(
                decoder.push(&stream, &mut Vec::new()).is_err(),
                "refused: {stream:?}"
            );
        }
        let mut decoder = MjpegDecoder::new("frame").expect("valid");
        assert!(
            decoder
                .push(&part("frame", &image), &mut Vec::new())
                .is_ok()
        );
    }

    #[test]
    fn a_boundary_is_one_to_seventy_letters_digits_underscores_or_dashes() {
        assert!(MjpegDecoder::new("frame_1-x").is_ok());
        assert!(MjpegDecoder::new("").is_err());
        assert!(MjpegDecoder::new("a b").is_err());
        assert!(MjpegDecoder::new(&"a".repeat(71)).is_err());
    }
}
