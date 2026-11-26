// SPDX-License-Identifier: Apache-2.0

//! The `frames.process` cases, moved from TypeScript
//! (`packages/screen/src/frames.process.test.ts`): arbitrary fragments and consecutive frames
//! decode without changing payloads (`:4`), and oversized headers, oversized payloads and
//! truncated frames are rejected (`:14`). The hub's cases live beside it in `frame_hub`.

use super::{Frame, FrameDecoder, FrameHeader, HEADER_LIMIT, MAX_PAYLOAD_BYTES, wire_frame};
use crate::error::ScreenError;

/// The fixture (`testing/support.frame`): a JPEG frame of `bytes` bytes filled with `sequence`.
fn frame(sequence: u64, bytes: usize) -> Frame {
    let header = FrameHeader::v1("test", sequence, bytes);
    let payload: Vec<u8> = std::iter::repeat_n(sequence as u8, bytes).collect();
    wire_frame(header, &payload).unwrap_or_else(|error| panic!("{error}"))
}

fn make_decoder() -> FrameDecoder {
    FrameDecoder::new()
}

/// `frames.process.test.ts:4`.
#[test]
fn decodes_arbitrary_fragments_and_consecutive_frames_without_changing_payloads() {
    let first = frame(1, 8);
    let second = frame(2, 2_048);
    let mut packets = first.packet().to_vec();
    packets.extend_from_slice(second.packet());
    let mut output = Vec::new();
    let mut decoder = make_decoder();
    for chunk in packets.chunks(7) {
        decoder
            .push(chunk, &mut |frame| output.push(frame))
            .unwrap_or_else(|error| panic!("{error}"));
    }
    decoder.end().unwrap_or_else(|error| panic!("{error}"));
    let sequences: Vec<u64> = output.iter().map(|frame| frame.header.sequence).collect();
    assert_eq!(sequences, vec![1, 2]);
    assert_eq!(output[1].payload(), second.payload());
    assert_eq!(output[0].packet(), first.packet());
}

/// `frames.process.test.ts:14`: a header past the limit, a payload past the limit, and a frame
/// cut short all fail at the point they are read.
#[test]
fn rejects_oversized_headers_oversized_payloads_and_truncated_frames() {
    let mut length = vec![0_u8; 4];
    length.copy_from_slice(&(HEADER_LIMIT as u32 + 1).to_be_bytes());
    let mut decoder = make_decoder();
    assert!(matches!(
        decoder.push(&length, &mut |_| {}),
        Err(ScreenError::HeaderExceedsLimit)
    ));

    let mut header = FrameHeader::v1("test", 1, 8).raw().clone();
    if let Some(object) = header.as_object_mut() {
        object.insert(
            "bytes".to_owned(),
            ace_json::Value::from(MAX_PAYLOAD_BYTES as f64 + 1.0),
        );
    }
    let json = header.to_json();
    let mut oversize = Vec::new();
    oversize.extend_from_slice(&(json.len() as u32).to_be_bytes());
    oversize.extend_from_slice(json.as_bytes());
    assert!(matches!(
        make_decoder().push(&oversize, &mut |_| {}),
        Err(ScreenError::InvalidHeader)
    ));

    let packet = frame(1, 8).packet().to_vec();
    let mut partial = make_decoder();
    partial
        .push(&packet[..packet.len() - 1], &mut |_| {})
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(matches!(partial.end(), Err(ScreenError::Truncated)));
}
