//! Live video: the capture texture through media-mf's D3D11 video processor (BGRA to NV12 and
//! the scale, in one blit) into an H.264 MFT. A hardware MFT takes the NV12 texture itself; the
//! software MFT costs one counted readback. Each unit leaves as Annex B with its picture's
//! capture time, scale and epoch.
use crate::{
    errors::{Code, Error, Result},
    media::{annexb::AnnexB, config::encode_size, config::StreamSettings},
};
use media_codec::{Codec, CodecError, EncodeSpec, Encoder, RateControl, Size};
use media_ingest::VideoUnit;
use media_mf::{Copies, MfDevice, MfEncoder, MfSurface};
use std::collections::VecDeque;

/// What a picture carried into the encoder, found again by its timestamp on the way out.
#[derive(Clone, Copy, Debug)]
pub struct Captured {
    pub captured_us: u64,
    pub timestamp_ms: f64,
    pub scale: f64,
    pub epoch: u32,
}

pub struct VideoEncoder {
    device: MfDevice,
    encoder: MfEncoder,
    spec: Option<EncodeSpec>,
    annexb: AnnexB,
    in_flight: VecDeque<(u64, Captured)>,
    copies: Copies,
    last_pts: u64,
}

fn codec_error(error: CodecError) -> Error {
    Error::new(Code::Internal, format!("Media Foundation: {error}"))
}

impl VideoEncoder {
    pub fn new(device: MfDevice) -> Result<Self> {
        Ok(Self {
            encoder: MfEncoder::new(Some(device.clone())).map_err(codec_error)?,
            device,
            spec: None,
            annexb: AnnexB::default(),
            in_flight: VecDeque::new(),
            copies: Copies::default(),
            last_pts: 0,
        })
    }

    pub fn hardware(&self) -> bool {
        self.encoder.hardware()
    }

    /// Readbacks and uploads the last picture cost.
    pub fn last_copies(&self) -> Copies {
        self.copies
    }

    /// Encodes one capture texture (BGRA, on this encoder's device) at the size `settings`
    /// allow. Returns the units ready now, without their sequence (the caller numbers them).
    ///
    /// # Safety
    /// `texture` is a live `ID3D11Texture2D` pointer of this encoder's device.
    pub unsafe fn encode(
        &mut self,
        texture: *mut std::ffi::c_void,
        source: (u32, u32),
        settings: StreamSettings,
        captured: Captured,
        force_key: bool,
    ) -> Result<Vec<VideoUnit>> {
        let (width, height) = encode_size(source, (settings.max_width, settings.max_height));
        let spec = EncodeSpec {
            codec: Codec::H264,
            size: Size { width, height },
            fps: settings.fps,
            rate: RateControl::Bitrate(settings.bitrate),
        };
        let mut force_key = force_key;
        if self.spec.as_ref() != Some(&spec) {
            // A new session (size, rate or fps) starts with its own parameter sets.
            self.encoder.configure(&spec).map_err(codec_error)?;
            self.spec = Some(spec);
            self.annexb.reset();
            force_key = true;
        }
        let surface =
            unsafe { MfSurface::from_raw_texture(&self.device, texture) }.map_err(codec_error)?;
        // Strictly increasing timestamps, so each unit finds its picture again.
        let pts = captured.captured_us.max(self.last_pts + 1);
        self.last_pts = pts;
        match self.encoder.encode(surface.into_picture(pts), force_key) {
            Ok(()) => {
                self.copies = self.encoder.last_copies();
                self.in_flight.push_back((pts, captured));
                while self.in_flight.len() > 32 {
                    self.in_flight.pop_front();
                }
            }
            // The MFT holds enough pictures: this one is skipped, the next is encoded.
            Err(CodecError::Backpressure) => {}
            Err(error) => return Err(codec_error(error)),
        }
        self.collect()
    }

    fn collect(&mut self) -> Result<Vec<VideoUnit>> {
        let mut units = Vec::new();
        while let Some(unit) = self.encoder.poll_result().map_err(codec_error)? {
            // Pictures before this one were dropped by the MFT.
            while self
                .in_flight
                .front()
                .is_some_and(|(pts, _)| *pts < unit.pts_us)
            {
                self.in_flight.pop_front();
            }
            let Some((_, captured)) = self.in_flight.pop_front() else {
                continue;
            };
            let Some(converted) = self.annexb.convert(&unit) else {
                continue;
            };
            units.push(VideoUnit {
                sequence: 0,
                timestamp_ms: captured.timestamp_ms,
                scale: captured.scale,
                width: unit.size.width,
                height: unit.size.height,
                key: converted.key,
                codec: converted.codec,
                epoch: captured.epoch,
                captured_us: captured.captured_us,
                payload: converted.payload,
            });
        }
        Ok(units)
    }
}
