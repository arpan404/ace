//! Voice recordings (ADR 0134): kept by hash in `<data>/audio`, in the formats endpoints and
//! browsers share.

use spade_core::event::VoiceRef;

use super::store::HashStore;

/// The largest recording kept.
pub const MOST_AUDIO_BYTES: usize = spade_models::MOST_AUDIO_BYTES;

/// The media type `bytes` really are, from their first bytes.
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        Some("audio/webm")
    } else if bytes.starts_with(b"OggS") {
        Some("audio/ogg")
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        Some("audio/mp4")
    } else if bytes.starts_with(b"ID3")
        || (bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] & 0xE0 == 0xE0)
    {
        Some("audio/mpeg")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        Some("audio/wav")
    } else {
        None
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AudioError {
    #[error("the recording is larger than 25 MB")]
    TooLarge,
    #[error("the recording is not WebM, Ogg, MP4, MP3 or WAV audio")]
    NotAudio,
    #[error("the recording could not be stored: {0}")]
    Io(String),
}

#[derive(Debug, Clone)]
pub struct AudioStore(pub(super) HashStore);

impl AudioStore {
    pub fn put(&self, bytes: &[u8]) -> Result<VoiceRef, AudioError> {
        if bytes.len() > MOST_AUDIO_BYTES {
            return Err(AudioError::TooLarge);
        }
        let media_type = sniff(bytes).ok_or(AudioError::NotAudio)?;
        let sha256 = self
            .0
            .put(bytes)
            .map_err(|e| AudioError::Io(e.to_string()))?;
        Ok(VoiceRef {
            sha256,
            media_type: media_type.to_owned(),
            bytes: bytes.len() as u64,
        })
    }

    /// A stored recording and its media type.
    pub fn read(&self, sha256: &str) -> Option<(Vec<u8>, &'static str)> {
        let bytes = self.0.read(sha256)?;
        let media_type = sniff(&bytes)?;
        Some((bytes, media_type))
    }
}
