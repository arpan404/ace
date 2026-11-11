//! Images the person attaches, stored once by content hash under the data folder. Events hold
//! only an [`ImageRef`], so the conversation log stays small, and the same bytes come back on
//! every prompt rebuild, which keeps the provider's cache warm.

use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use sha2::{Digest, Sha256};
use spade_core::context::Images;
use spade_core::event::ImageRef;
use spade_models::Image;

/// The most images one message may carry.
pub const MOST_IMAGES: usize = 8;
/// The largest image accepted, in bytes.
pub const MOST_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ImageError {
    #[error("an image is larger than 5 MB")]
    TooLarge,
    #[error("an attachment is not a PNG, JPEG, GIF or WebP image")]
    NotAnImage,
    #[error("an image is not valid base64")]
    BadEncoding,
    #[error("the image could not be stored: {0}")]
    Io(String),
}

/// The media type `bytes` really are, from their first bytes. Only formats every endpoint reads.
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// Decodes an upload sent as base64, with or without a `data:` prefix.
pub fn decode(data: &str) -> Result<Vec<u8>, ImageError> {
    let data = match data.split_once(";base64,") {
        Some((prefix, rest)) if prefix.starts_with("data:") => rest,
        _ => data,
    };
    // A rough bound before decoding, so a huge upload is refused without allocating it.
    if data.len() / 4 * 3 > MOST_BYTES + 3 {
        return Err(ImageError::TooLarge);
    }
    STANDARD
        .decode(data.trim())
        .map_err(|_| ImageError::BadEncoding)
}

#[derive(Debug, Clone)]
pub struct ImageStore {
    dir: PathBuf,
}

impl ImageStore {
    pub fn open(dir: &Path) -> Result<Self, ImageError> {
        std::fs::create_dir_all(dir).map_err(|e| ImageError::Io(e.to_string()))?;
        Ok(Self {
            dir: dir.to_owned(),
        })
    }

    /// Checks and stores `bytes`, once per distinct image.
    pub fn put(&self, bytes: &[u8]) -> Result<ImageRef, ImageError> {
        if bytes.len() > MOST_BYTES {
            return Err(ImageError::TooLarge);
        }
        let media_type = sniff(bytes).ok_or(ImageError::NotAnImage)?;
        let sha256 = hex(&Sha256::digest(bytes));
        let path = self.dir.join(&sha256);
        if !path.exists() {
            // Written aside and renamed, so a crash never leaves half an image under its hash.
            let mut file = tempfile::NamedTempFile::new_in(&self.dir)
                .map_err(|e| ImageError::Io(e.to_string()))?;
            file.write_all(bytes)
                .map_err(|e| ImageError::Io(e.to_string()))?;
            file.persist(&path)
                .map_err(|e| ImageError::Io(e.to_string()))?;
        }
        Ok(ImageRef {
            sha256,
            media_type: media_type.to_owned(),
            bytes: bytes.len() as u64,
        })
    }

    /// The stored image with this hash, and its media type.
    pub fn read(&self, sha256: &str) -> Option<(Vec<u8>, &'static str)> {
        let valid = sha256.len() == 64 && sha256.bytes().all(|b| b.is_ascii_hexdigit());
        if !valid {
            return None;
        }
        let bytes = std::fs::read(self.dir.join(sha256.to_ascii_lowercase())).ok()?;
        let media_type = sniff(&bytes)?;
        Some((bytes, media_type))
    }

    /// The images a prompt for a model shows: the stored bytes if the model can see images.
    pub fn for_model(&self, can_see: bool) -> ModelImages<'_> {
        ModelImages {
            store: self,
            can_see,
        }
    }
}

pub struct ModelImages<'a> {
    store: &'a ImageStore,
    can_see: bool,
}

impl Images for ModelImages<'_> {
    fn get(&self, image: &ImageRef) -> Result<Image, String> {
        if !self.can_see {
            return Err("this model cannot see images".to_owned());
        }
        let (bytes, media_type) = self
            .store
            .read(&image.sha256)
            .ok_or_else(|| "the image is no longer stored".to_owned())?;
        Ok(Image {
            media_type: media_type.to_owned(),
            data: STANDARD.encode(bytes).into(),
        })
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR";

    #[test]
    fn only_real_images_of_common_formats_are_accepted() {
        assert_eq!(sniff(PNG), Some("image/png"));
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff(b"GIF89a.."), Some("image/gif"));
        assert_eq!(sniff(b"RIFF\x00\x00\x00\x00WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff(b"<svg xmlns=..."), None);
        assert_eq!(sniff(b"%PDF-1.7"), None);
    }

    #[test]
    fn an_image_is_stored_once_by_hash_and_read_back_for_a_model_that_can_see() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let store = ImageStore::open(dir.path()).unwrap_or_else(|e| panic!("{e}"));
        let first = store.put(PNG).unwrap_or_else(|e| panic!("{e}"));
        let again = store.put(PNG).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(first, again);
        assert_eq!(first.media_type, "image/png");
        assert_eq!(
            std::fs::read_dir(dir.path())
                .map(|d| d.count())
                .unwrap_or(0),
            1
        );

        let shown = store
            .for_model(true)
            .get(&first)
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            STANDARD.decode(shown.data.as_bytes()).ok().as_deref(),
            Some(PNG)
        );
        assert_eq!(
            store.for_model(false).get(&first),
            Err("this model cannot see images".to_owned())
        );
        assert_eq!(store.put(b"plain text"), Err(ImageError::NotAnImage));
        assert_eq!(store.read("../etc/passwd"), None);
    }

    #[test]
    fn uploads_decode_with_or_without_a_data_prefix_and_huge_ones_are_refused_early() {
        let encoded = STANDARD.encode(PNG);
        assert_eq!(decode(&encoded).ok().as_deref(), Some(PNG));
        assert_eq!(
            decode(&format!("data:image/png;base64,{encoded}"))
                .ok()
                .as_deref(),
            Some(PNG)
        );
        assert_eq!(decode("not base64!"), Err(ImageError::BadEncoding));
        assert_eq!(
            decode(&"A".repeat(8 * 1024 * 1024)),
            Err(ImageError::TooLarge)
        );
    }
}
