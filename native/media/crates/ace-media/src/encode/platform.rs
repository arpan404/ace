// SPDX-License-Identifier: Apache-2.0
//! The real backends for JPEG sources, chosen from the probe's capabilities: VideoToolbox on
//! macOS (JPEG decode on its hardware session where the probe observed one, straight into the
//! encoder's surfaces), and the last-resort Chrome encoder where no hardware encoder works.
use super::select::{encoder_for, jpeg_decode_hardware};
use super::worker::{Backends, Chosen, Decoded};
use media_chrome::{ChromeEncoder, ChromeOptions, jpeg_picture};
use media_codec::{Codec, CodecError, CpuJpegCodec, JpegCodec, Size};
use media_wire::capability::{Backend, Capability};
use std::sync::{Arc, Mutex};

/// The capability list as the probe last reported it; late trials replace their entries.
pub type SharedCapabilities = Arc<Mutex<Vec<Capability>>>;

pub struct Platform {
    capabilities: SharedCapabilities,
    chrome: Option<ChromeOptions>,
    cpu: CpuJpegCodec,
    #[cfg(target_os = "macos")]
    vt: Option<media_vt::VtJpeg>,
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
        match encoder_for(&capabilities, codec) {
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
            let vt = self.vt.get_or_insert_with(|| {
                let output = media_vt::VtFormat::Nv12;
                if hardware {
                    media_vt::VtJpeg::new(output)
                } else {
                    media_vt::VtJpeg::without_hardware(output)
                }
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
}
