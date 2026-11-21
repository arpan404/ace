// SPDX-License-Identifier: Apache-2.0
//! Why a job was refused: a reason the daemon acts on and a sentence it may show.
pub use media_wire::image::ImageFailure;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failed {
    pub reason: ImageFailure,
    pub message: String,
}

impl Failed {
    pub fn new(reason: ImageFailure, message: impl Into<String>) -> Self {
        Self {
            reason,
            message: message.into(),
        }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ImageFailure::Invalid, message)
    }
    pub fn too_large(message: impl Into<String>) -> Self {
        Self::new(ImageFailure::TooLarge, message)
    }
    pub fn truncated(format: &str) -> Self {
        Self::new(
            ImageFailure::Truncated,
            format!("The {format} ends early: the image is incomplete."),
        )
    }
    pub fn decode(format: &str, detail: impl std::fmt::Display) -> Self {
        Self::new(
            ImageFailure::DecodeFailed,
            format!("The {format} could not be decoded: {detail}."),
        )
    }
}

pub type Result<T> = std::result::Result<T, Failed>;
