// SPDX-License-Identifier: Apache-2.0
//! RFC 6455 §5.2's header, decided from the bytes alone: the two fixed bytes,
//! then the extended length. Anything that depends on the message already in
//! flight (fragmentation, the 1 MiB total) is the assembler's, asked separately.

use super::{FrameError, Opcode};

/// The first two bytes, after every rule that can be decided from them.
#[derive(Debug, Clone, Copy)]
pub struct First {
    pub fin: bool,
    pub rsv1: bool,
    pub opcode: Opcode,
    /// The 7-bit length: the payload's length, or 126/127 naming a longer field.
    pub short: u8,
}

/// Checks the two fixed bytes. `allow_rsv1` is whether an extension was
/// negotiated; without one, RSV1 is a violation on every opcode.
pub fn parse_first(bytes: [u8; 2], allow_rsv1: bool) -> Result<First, FrameError> {
    let [first, second] = bytes;

    // receiver.js:207-215: RSV2 and RSV3 must be clear.
    if first & 0x30 != 0 {
        return Err(FrameError::protocol(
            "Invalid WebSocket frame: RSV2 and RSV3 must be clear",
        ));
    }

    let rsv1 = first & 0x40 != 0;
    let fin = first & 0x80 != 0;
    let raw = first & 0x0f;
    let opcode = Opcode::from_code(raw).ok_or_else(|| {
        FrameError::protocol(format!("Invalid WebSocket frame: invalid opcode {raw}"))
    })?;

    // receiver.js:221-228, :294-307: RSV1 without an extension, and always on a
    // continuation or a control frame.
    if rsv1 && (!allow_rsv1 || opcode == Opcode::Continuation || opcode.is_control()) {
        return Err(FrameError::protocol(
            "Invalid WebSocket frame: RSV1 must be clear",
        ));
    }

    // receiver.js:281-292: a control frame is FIN and at most 125 bytes, and a
    // close frame is never one byte (a code needs two).
    if opcode.is_control() {
        if !fin {
            return Err(FrameError::protocol(
                "Invalid WebSocket frame: FIN must be set",
            ));
        }
        if second & 0x7f > 125 {
            return Err(FrameError::protocol(format!(
                "Invalid WebSocket frame: invalid payload length {}",
                second & 0x7f
            )));
        }
        if opcode == Opcode::Close && second & 0x7f == 1 {
            return Err(FrameError::protocol(
                "Invalid WebSocket frame: invalid payload length 1",
            ));
        }
    }

    // receiver.js:343-352: the daemon is the server, so a client frame is masked.
    if second & 0x80 == 0 {
        return Err(FrameError::protocol(
            "Invalid WebSocket frame: MASK must be set",
        ));
    }

    Ok(First {
        fin,
        rsv1,
        opcode,
        short: second & 0x7f,
    })
}

/// The payload length, given the 7-bit value and the extended bytes that follow
/// when it names them. A 64-bit length over JavaScript's safe integer is 1009,
/// as receiver.js:403-424 has it; the top bit is always over that bound.
pub fn payload_length(short: u8, extended: &[u8]) -> Result<usize, FrameError> {
    let length = match short {
        126 => {
            let bytes: [u8; 2] = extended
                .get(..2)
                .and_then(|bytes| bytes.try_into().ok())
                .ok_or_else(|| FrameError::too_big("truncated 16-bit payload length"))?;
            usize::from(u16::from_be_bytes(bytes))
        }
        127 => {
            let bytes: [u8; 8] = extended
                .get(..8)
                .and_then(|bytes| bytes.try_into().ok())
                .ok_or_else(|| FrameError::too_big("truncated 64-bit payload length"))?;
            let length = u64::from_be_bytes(bytes);
            // ws's bound: 2^53 - 1, JavaScript's largest exact integer.
            if length > (1u64 << 53) - 1 {
                return Err(FrameError::too_big(
                    "Unsupported WebSocket frame: payload length > 2^53 - 1",
                ));
            }
            usize::try_from(length)
                .map_err(|_| FrameError::too_big("payload length does not fit this machine"))?
        }
        length => usize::from(length),
    };
    Ok(length)
}

/// How many extended bytes a 7-bit length names: 0, 2 or 8.
pub fn extended_len(short: u8) -> usize {
    match short {
        126 => 2,
        127 => 8,
        _ => 0,
    }
}
