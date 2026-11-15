// SPDX-License-Identifier: Apache-2.0
//! The real backends for JPEG sources, chosen from the probe's capabilities: VideoToolbox on
//! macOS (JPEG decode on its hardware session where the probe observed one, straight into the
//! encoder's surfaces), and the last-resort Chrome encoder where no hardware encoder works.
use super::select::encoder_for;
#[cfg(target_os = "macos")]
use super::select::jpeg_decode_hardware;
use super::worker::{Backends, Chosen, Decoded};
use media_chrome::{ChromeEncoder, ChromeOptions, jpeg_picture};
use media_codec::{Codec, CodecError, CpuJpegCodec, JpegCodec, Size};
use media_wire::capability::{Backend, Capability};
use std::sync::{Arc, Mutex};

/// The hardware encoders `Platform::encoder` constructs, one per arm of its match. Only these
/// backends' probe entries choose an encoder or turn the last-resort encoder off; a backend
/// probed but missing here (VA-API, Media Foundation and NVENC are not wired into the JPEG
/// encoder yet) leaves the fallback on. The daemon offers picture codecs from the same table,
/// `packages/media/src/picture-encoders.json`; a test keeps the two equal.
pub const BUILT_ENCODERS: &[Backend] = &[
    #[cfg(target_os = "macos")]
    Backend::Vt,
];

/// The capability list as the probe last reported it; late trials replace their entries.
pub type SharedCapabilities = Arc<Mutex<Vec<Capability>>>;

pub struct Platform {
    capabilities: SharedCapabilities,
    chrome: Option<ChromeOptions>,
    cpu: CpuJpegCodec,
    /// The VideoToolbox JPEG decoder, and whether it was built on hardware.
    #[cfg(target_os = "macos")]
    vt: Option<(media_vt::VtJpeg, bool)>,
}

impl Platform {
    pub fn new(capabilities: SharedCapabilities, chrome: Option<ChromeOptions>) -> Self {
        Self {
            capabilities,
            chrome,
            cpu: CpuJpegCodec::default(),
            #[cfg(target_os = "macos")]
            vt: None,
        }
    }

    fn capabilities(&self) -> Vec<Capability> {
        self.capabilities
            .lock()
            .map(|c| c.clone())
            .unwrap_or_default()
    }

    fn cpu_decode(&mut self, jpeg: &[u8], size: Size) -> Result<Decoded, CodecError> {
        let picture = JpegCodec::decode(&mut self.cpu, jpeg, size.width, size.height)?;
        Ok(Decoded {
            picture,
            backend: Backend::Cpu,
            hardware: false,
            uploads: 0,
        })
    }
}

impl Backends for Platform {
    fn encoder(&mut self, codec: Codec) -> Result<Chosen, CodecError> {
        let capabilities = self.capabilities();
        match encoder_for(&capabilities, codec, BUILT_ENCODERS) {
            #[cfg(target_os = "macos")]
            Some((Backend::Vt, hardware)) => Ok(Chosen {
                encoder: Box::new(media_vt::VtEncoder::new()),
                backend: Backend::Vt,
                hardware,
                takes_jpeg: None,
            }),
            Some((Backend::Chrome, _)) => {
                let options = self
                    .chrome
                    .clone()
                    .ok_or_else(|| CodecError::Unsupported("no Chrome to encode with".into()))?;
                Ok(Chosen {
                    encoder: Box::new(ChromeEncoder::new(options)),
                    backend: Backend::Chrome,
                    hardware: false,
                    takes_jpeg: Some(jpeg_picture),
                })
            }
            _ => Err(CodecError::Unsupported(
                "no encoder for this codec here".into(),
            )),
        }
    }

    fn decode(&mut self, jpeg: &[u8], size: Size, encoder: Backend) -> Result<Decoded, CodecError> {
        #[cfg(target_os = "macos")]
        if encoder == Backend::Vt {
            let hardware = jpeg_decode_hardware(&self.capabilities(), Backend::Vt);
            let (vt, _) = self.vt.get_or_insert_with(|| {
                let output = media_vt::VtFormat::Nv12;
                let decoder = if hardware {
                    media_vt::VtJpeg::new(output)
                } else {
                    media_vt::VtJpeg::without_hardware(output)
                };
                (decoder, hardware)
            });
            let picture = JpegCodec::decode(vt, jpeg, size.width, size.height)?;
            let path = vt.last_path();
            return Ok(Decoded {
                picture,
                backend: if path.hardware {
                    Backend::Vt
                } else {
                    Backend::Cpu
                },
                hardware: path.hardware,
                uploads: path.copies.uploads,
            });
        }
        let _ = encoder;
        self.cpu_decode(jpeg, size)
    }

    fn probed(&self) -> Vec<Capability> {
        self.capabilities()
    }

    fn choice(&self, codec: Codec) -> Option<(Backend, bool)> {
        encoder_for(&self.capabilities(), codec, BUILT_ENCODERS)
    }

    fn refresh(&mut self) {
        // A JPEG decoder built before the probe observed a hardware one is built again.
        #[cfg(target_os = "macos")]
        if self.vt.as_ref().is_some_and(|(_, hardware)| !hardware)
            && jpeg_decode_hardware(&self.capabilities(), Backend::Vt)
        {
            self.vt = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The daemon offers picture codecs from `picture-encoders.json`; it must name exactly the
    /// encoders this build constructs, or the daemon would ask for encodes ace-media refuses.
    #[test]
    fn the_daemons_picture_encoder_table_names_what_this_build_constructs() {
        let text = include_str!("../../../../../../packages/media/src/picture-encoders.json");
        let table: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
        let platform = match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            other => other,
        };
        let listed: Vec<Backend> = table
            .get(platform)
            .and_then(|list| serde_json::from_value(list.clone()).ok())
            .unwrap_or_default();
        assert_eq!(
            listed, BUILT_ENCODERS,
            "{platform} in picture-encoders.json"
        );
    }
}
