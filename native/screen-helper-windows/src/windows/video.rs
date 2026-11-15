//! Live video: the capture texture through media-mf's D3D11 video processor (BGRA to NV12 and
//! the scale, in one blit) into an H.264 MFT. A hardware MFT takes the NV12 texture itself; the
//! software MFT costs one counted readback. Each unit leaves as Annex B with its picture's
//! capture time, scale and epoch.
use crate::{
    errors::{Code, Error, Result},
    media::{config::encode_size, config::StreamSettings},
};
use media_codec::{Codec, CodecError, EncodeSpec, Encoder, RateControl, Size};
use media_ingest::VideoUnit;
use media_mf::{Copies, MfDevice, MfEncoder, MfSurface};

pub use crate::media::pump::Captured;
use crate::media::pump::{Live, Pump};

impl Live for MfEncoder {
    fn service(&mut self) -> std::result::Result<(), CodecError> {
        MfEncoder::service(self)
    }
}

pub struct VideoEncoder {
    device: MfDevice,
    pump: Pump<MfEncoder>,
    spec: Option<EncodeSpec>,
    copies: Copies,
}

fn codec_error(error: CodecError) -> Error {
    Error::new(Code::Internal, format!("Media Foundation: {error}"))
}

impl VideoEncoder {
    pub fn new(device: MfDevice) -> Result<Self> {
        Ok(Self {
            pump: Pump::new(MfEncoder::new(Some(device.clone())).map_err(codec_error)?),
            device,
            spec: None,
            copies: Copies::default(),
        })
    }

    pub fn hardware(&self) -> bool {
        self.pump.encoder().hardware()
    }

    /// Readbacks and uploads the last picture cost.
    pub fn last_copies(&self) -> Copies {
        self.copies
    }

    /// Pictures whose units haven't come out: `service` is owed on a timer.
    pub fn owed(&self) -> bool {
        self.pump.owed()
    }

    /// Late output and the stall watchdog, between pictures.
    pub fn service(&mut self) -> Result<Vec<VideoUnit>> {
        self.pump.service().map_err(codec_error)
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
            self.pump
                .encoder_mut()
                .configure(&spec)
                .map_err(codec_error)?;
            self.spec = Some(spec);
            self.pump.reset_stream();
            force_key = true;
        }
        let surface =
            unsafe { MfSurface::from_raw_texture(&self.device, texture) }.map_err(codec_error)?;
        let pts = self.pump.next_pts(captured.captured_us);
        let units = self
            .pump
            .submit(surface.into_picture(pts), captured, force_key)
            .map_err(codec_error)?;
        self.copies = self.pump.encoder().last_copies();
        Ok(units)
    }
}
