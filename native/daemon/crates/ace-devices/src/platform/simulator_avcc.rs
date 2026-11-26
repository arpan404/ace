// SPDX-License-Identifier: Apache-2.0
//! `simulator-avcc.ts`: serve-sim's `/stream.avcc` is a sequence of records: a 32-bit big-endian
//! length, then that many bytes, the first of which is a tag. Tag 1 carries an avcC decoder
//! configuration, 2 an IDR access unit and 3 a delta access unit, both as length-prefixed NAL
//! units. Other tags (a JPEG preview seed, future additions) are handed on raw, never treated
//! as an error. [`crate::platform::h264`] reads the description and rewrites the access units.

use crate::platform::Error;

/// The largest one record may be, in bytes: the length prefix included.
pub const RECORD_LIMIT: usize = 8 * 1024 * 1024;

/// One record from serve-sim's stream, with its tag resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AvccRecord {
    /// Tag 1: an avcC decoder configuration.
    Description(Vec<u8>),
    /// Tag 2: an IDR access unit, as length-prefixed NAL units.
    Key(Vec<u8>),
    /// Tag 3: a delta access unit, as length-prefixed NAL units.
    Delta(Vec<u8>),
    /// Any other tag, kept raw.
    Other { tag: u8, body: Vec<u8> },
}

impl AvccRecord {
    /// The record's tag byte, as the stream spelled it.
    pub fn tag(&self) -> u8 {
        match self {
            Self::Description(_) => 1,
            Self::Key(_) => 2,
            Self::Delta(_) => 3,
            Self::Other { tag, .. } => *tag,
        }
    }

    /// The record's body, after the tag byte.
    pub fn body(&self) -> &[u8] {
        match self {
            Self::Description(body) | Self::Key(body) | Self::Delta(body) => body,
            Self::Other { body, .. } => body,
        }
    }
}

/// Incremental record splitter. Work per chunk is proportional to the chunk, not the stream.
#[derive(Debug, Default)]
pub struct AvccRecords {
    buffer: Vec<u8>,
    start: usize,
}

impl AvccRecords {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds one chunk and returns every record it completed, in stream order. A record that is
    /// still arriving stays buffered; an empty or oversized one is refused at once.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<AvccRecord>, Error> {
        if chunk.is_empty() {
            return Ok(Vec::new());
        }
        self.buffer.extend_from_slice(chunk);
        let mut records = Vec::new();
        loop {
            let pending = &self.buffer[self.start..];
            if pending.len() < 4 {
                break;
            }
            let length = usize::from(pending[0]) << 24
                | usize::from(pending[1]) << 16
                | usize::from(pending[2]) << 8
                | usize::from(pending[3]);
            if !(1..=RECORD_LIMIT).contains(&length) {
                return Err(invalid("Simulator video record is invalid"));
            }
            if pending.len() < 4 + length {
                break;
            }
            let record = &pending[4..4 + length];
            let (tag, body) = (record[0], record[1..].to_vec());
            records.push(match tag {
                1 => AvccRecord::Description(body),
                2 => AvccRecord::Key(body),
                3 => AvccRecord::Delta(body),
                other => AvccRecord::Other { tag: other, body },
            });
            self.start += 4 + length;
        }
        self.compact();
        Ok(records)
    }

    /// Drops the bytes already taken, so the buffer never holds a record's worth of history.
    fn compact(&mut self) {
        if self.start == self.buffer.len() {
            self.buffer.clear();
            self.start = 0;
        } else if self.start >= 64 * 1024 {
            self.buffer.drain(..self.start);
            self.start = 0;
        }
    }
}

fn invalid(message: &str) -> Error {
    Error::Invalid(message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&text[at..at + 2], 16).expect("valid hex"))
            .collect()
    }

    fn record(tag: u8, body: &[u8]) -> Vec<u8> {
        let mut out = u32::try_from(body.len() + 1)
            .expect("record fits")
            .to_be_bytes()
            .to_vec();
        out.push(tag);
        out.extend_from_slice(body);
        out
    }

    fn sample(nals: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        for nal in nals {
            out.extend_from_slice(&u32::try_from(nal.len()).expect("nal fits").to_be_bytes());
            out.extend_from_slice(nal);
        }
        out
    }

    fn stream() -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        let description =
            hex("01640033ffe1001627640033ac13143c04c0149e6a9a81010103c20108f801000428ee3cb0");
        let idr = hex("25b8004001");
        let slice = hex("219a02");
        let mut stream = Vec::new();
        stream.extend(record(4, b"jpeg seed"));
        stream.extend(record(1, &description));
        stream.extend(record(2, &sample(&[&idr])));
        stream.extend(record(3, &sample(&[&slice])));
        stream.extend(record(9, &[7]));
        (stream, description, sample(&[&idr]))
    }

    fn shape(records: &[AvccRecord]) -> Vec<(u8, Vec<u8>)> {
        records
            .iter()
            .map(|record| (record.tag(), record.body().to_vec()))
            .collect()
    }

    #[test]
    fn stream_records_come_out_whole_however_the_bytes_are_split_unknown_tags_kept_raw() {
        let (stream, description, key) = stream();
        let mut split = AvccRecords::new();
        let mut records = Vec::new();
        for byte in &stream {
            records.extend(split.push(&[*byte]).expect("reads"));
        }
        assert_eq!(
            shape(&records),
            vec![
                (4, b"jpeg seed".to_vec()),
                (1, description),
                (2, key),
                (3, sample(&[&hex("219a02")])),
                (9, vec![7]),
            ]
        );
        assert!(matches!(records[2], AvccRecord::Key(_)));
        assert_eq!(records[3].tag(), 3);
    }

    #[test]
    fn an_empty_or_oversized_record_is_refused_rather_than_buffered() {
        assert!(
            AvccRecords::new()
                .push(&[0, 0, 0, 0, 1])
                .expect_err("refused")
                .to_string()
                .contains("invalid")
        );
        assert!(
            AvccRecords::new()
                .push(&[0x7f, 0, 0, 0, 2])
                .expect_err("refused")
                .to_string()
                .contains("invalid")
        );
    }

    #[test]
    fn a_record_arriving_one_byte_at_a_time_is_emitted_only_once_it_is_whole() {
        let (stream, _, _) = stream();
        let mut splitter = AvccRecords::new();
        let mut seen = Vec::new();
        for byte in &stream {
            for record in splitter.push(&[*byte]).expect("reads") {
                seen.push(record);
            }
        }
        assert_eq!(seen.len(), 5);
        // The JPEG seed's record is 14 bytes long: its first 13 complete nothing.
        let mut partial = AvccRecords::new();
        assert!(partial.push(&stream[..13]).expect("reads").is_empty());
        assert_eq!(partial.push(&stream[13..14]).expect("reads").len(), 1);
    }
}
