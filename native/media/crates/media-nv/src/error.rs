// SPDX-License-Identifier: Apache-2.0
//! Driver status codes to `CodecError`. Pure.
use crate::dec_abi::CuResult;
use crate::enc_abi::Status;
use media_codec::CodecError;

/// The documented `NVENCSTATUS` values, by name.
fn nvenc_name(status: Status) -> &'static str {
    match status {
        0 => "SUCCESS",
        1 => "NO_ENCODE_DEVICE",
        2 => "UNSUPPORTED_DEVICE",
        3 => "INVALID_ENCODERDEVICE",
        4 => "INVALID_DEVICE",
        5 => "DEVICE_NOT_EXIST",
        6 => "INVALID_PTR",
        7 => "INVALID_EVENT",
        8 => "INVALID_PARAM",
        9 => "INVALID_CALL",
        10 => "OUT_OF_MEMORY",
        11 => "ENCODER_NOT_INITIALIZED",
        12 => "UNSUPPORTED_PARAM",
        13 => "LOCK_BUSY",
        14 => "NOT_ENOUGH_BUFFER",
        15 => "INVALID_VERSION",
        16 => "MAP_FAILED",
        17 => "NEED_MORE_INPUT",
        18 => "ENCODER_BUSY",
        19 => "EVENT_NOT_REGISTERED",
        20 => "GENERIC",
        21 => "INCOMPATIBLE_CLIENT_KEY",
        22 => "UNIMPLEMENTED",
        23 => "RESOURCE_REGISTER_FAILED",
        24 => "RESOURCE_NOT_REGISTERED",
        25 => "RESOURCE_NOT_MAPPED",
        26 => "NEED_MORE_OUTPUT",
        _ => "UNKNOWN",
    }
}

/// `Ok` for success. A device the driver can't encode on, or a structure version it doesn't
/// know, is `Unsupported` (no backend); a busy encoder is `Backpressure`; the rest is a
/// backend failure naming the call.
pub fn nvenc(call: &'static str, status: Status) -> Result<(), CodecError> {
    let message = || format!("NVENC {call}: {} ({status})", nvenc_name(status));
    match status {
        0 => Ok(()),
        1 | 2 | 3 | 4 | 5 | 15 | 22 => Err(CodecError::Unsupported(message())),
        13 | 18 => Err(CodecError::Backpressure),
        8 | 12 => Err(CodecError::InvalidInput(message())),
        _ => Err(CodecError::Backend(message())),
    }
}

/// CUDA and NVDEC calls share `CUresult`. No device, no driver, or a codec or size the decoder
/// lacks is `Unsupported`; the rest is a backend failure naming the call.
pub fn cuda(call: &'static str, result: CuResult) -> Result<(), CodecError> {
    let message = || format!("NVDEC {call}: CUresult {result}");
    match result {
        0 => Ok(()),
        // NO_DEVICE, INVALID_DEVICE, NOT_SUPPORTED, insufficient or missing driver
        3 | 4 | 100 | 101 | 801 | 803 | 804 => Err(CodecError::Unsupported(message())),
        2 => Err(CodecError::Backend(format!(
            "{} (out of memory)",
            message()
        ))),
        _ => Err(CodecError::Backend(message())),
    }
}

pub fn missing(what: &str) -> CodecError {
    CodecError::Unsupported(format!("NVIDIA driver lacks {what}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_driver_without_the_device_or_the_pinned_version_means_no_backend() {
        for status in [1, 2, 5, 15] {
            assert!(matches!(
                nvenc("x", status),
                Err(CodecError::Unsupported(_))
            ));
        }
        assert!(matches!(cuda("x", 100), Err(CodecError::Unsupported(_))));
        assert!(matches!(cuda("x", 803), Err(CodecError::Unsupported(_))));
    }

    #[test]
    fn a_busy_encoder_is_backpressure_not_failure() {
        assert_eq!(nvenc("x", 18), Err(CodecError::Backpressure));
        assert_eq!(nvenc("x", 13), Err(CodecError::Backpressure));
    }

    #[test]
    fn other_failures_name_the_call_and_the_status() {
        assert_eq!(
            nvenc("nvEncEncodePicture", 10),
            Err(CodecError::Backend(
                "NVENC nvEncEncodePicture: OUT_OF_MEMORY (10)".into()
            ))
        );
        assert_eq!(
            nvenc("nvEncInitializeEncoder", 8),
            Err(CodecError::InvalidInput(
                "NVENC nvEncInitializeEncoder: INVALID_PARAM (8)".into()
            ))
        );
        assert_eq!(
            cuda("cuvidCreateDecoder", 2),
            Err(CodecError::Backend(
                "NVDEC cuvidCreateDecoder: CUresult 2 (out of memory)".into()
            ))
        );
        assert_eq!(nvenc("x", 0), Ok(()));
        assert_eq!(cuda("x", 0), Ok(()));
    }
}
