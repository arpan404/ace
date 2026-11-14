// SPDX-License-Identifier: Apache-2.0
//! One encoder MFT, opened and configured for low-latency streaming (docs/media/plan.md,
//! "Helper changes > Windows", step 4): low-latency mode, no B-frames, a GOP long enough
//! that keyframes come only on request, low-delay VBR or QP, and forced keyframes.
use super::com::Ctx;
use super::device::MfDevice;
use super::mft::{Listed, Transform, list, tag_bt709, video_type};
use super::variant;
use crate::{Vendor, order_encoders};
use media_codec::{Codec, CodecError, EncodeSpec, RateControl};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Variant::VARIANT;
use windows_core::{GUID, Interface};

pub(crate) fn subtype(codec: Codec) -> Result<GUID, CodecError> {
    match codec {
        Codec::H264 => Ok(MFVideoFormat_H264),
        Codec::Hevc => Ok(MFVideoFormat_HEVC),
        other => Err(CodecError::Unsupported(format!(
            "{other:?} through Media Foundation"
        ))),
    }
}

/// The encoder MFTs for `codec`, in the order to try them.
pub(crate) fn encoders(codec: Codec, adapter: Option<Vendor>) -> Result<Vec<Listed>, CodecError> {
    let listed = list(
        MFT_CATEGORY_VIDEO_ENCODER,
        MFVideoFormat_NV12,
        subtype(codec)?,
    );
    let candidates: Vec<_> = listed.iter().map(|l| l.candidate.clone()).collect();
    let order = order_encoders(&candidates, adapter);
    let mut slots: Vec<Option<Listed>> = listed.into_iter().map(Some).collect();
    Ok(order.into_iter().filter_map(|i| slots[i].take()).collect())
}

pub(crate) struct Settings(Option<ICodecAPI>);
impl Settings {
    pub fn of(transform: &Transform) -> Self {
        Self(transform.mft.cast::<ICodecAPI>().ok())
    }
    /// `CODECAPI_AVLowLatencyMode`: one picture out per picture in, where the codec can.
    pub fn low_latency(&self) -> bool {
        self.set(&CODECAPI_AVLowLatencyMode, &variant::bool(true))
    }
    fn set(&self, key: &GUID, value: &VARIANT) -> bool {
        // SAFETY: A plain-value VARIANT; the codec copies it.
        self.0
            .as_ref()
            .is_some_and(|api| unsafe { api.SetValue(key, value) }.is_ok())
    }
    fn supported(&self, key: &GUID) -> bool {
        // SAFETY: Query only.
        self.0
            .as_ref()
            .is_some_and(|api| unsafe { api.IsSupported(key) }.is_ok())
    }
    /// QP packed into every 16-bit lane: the default and the per-frame-type values.
    fn qp(q: u8) -> u64 {
        let q = u64::from(q);
        q | (q << 16) | (q << 32) | (q << 48)
    }
    pub fn rate(&self, rate: RateControl) -> bool {
        match rate {
            RateControl::Bitrate(bits) => {
                self.set(&CODECAPI_AVEncCommonMeanBitRate, &variant::u32(bits))
            }
            RateControl::Quantizer(q) => {
                self.set(&CODECAPI_AVEncVideoEncodeQP, &variant::u64(Self::qp(q)))
            }
        }
    }
    pub fn force_key(&self) -> bool {
        self.set(&CODECAPI_AVEncVideoForceKeyFrame, &variant::u32(1))
    }
}

pub(crate) struct Session {
    pub transform: Transform,
    pub settings: Settings,
    pub spec: EncodeSpec,
    /// The MFT takes `CODECAPI_AVEncVideoEncodeQP`.
    pub quantizer: bool,
}

impl Session {
    /// Opens the first MFT in `listed` that takes `spec`. Hardware MFTs get `device`.
    pub fn open(
        listed: &[Listed],
        spec: &EncodeSpec,
        device: Option<&MfDevice>,
    ) -> Result<Self, CodecError> {
        let mut last = CodecError::Unsupported(format!("no {:?} encoder MFT", spec.codec));
        for candidate in listed {
            if candidate.candidate.hardware && device.is_none() {
                continue;
            }
            match Self::open_one(candidate, spec, device) {
                Ok(session) => return Ok(session),
                Err(e) => last = e,
            }
        }
        Err(last)
    }

    fn open_one(
        listed: &Listed,
        spec: &EncodeSpec,
        device: Option<&MfDevice>,
    ) -> Result<Self, CodecError> {
        let mut transform = Transform::open(listed, device, false)?;
        let settings = Settings::of(&transform);
        // Before the types: some encoders fix these when the output type is set.
        settings.low_latency();
        settings.set(&CODECAPI_AVEncMPVDefaultBPictureCount, &variant::u32(0));
        settings.set(
            &CODECAPI_AVEncMPVGOPSize,
            &variant::u32(spec.fps.saturating_mul(3600)),
        );
        let quantizer = settings.supported(&CODECAPI_AVEncVideoEncodeQP);
        let mode = match spec.rate {
            RateControl::Bitrate(_) => eAVEncCommonRateControlMode_LowDelayVBR,
            RateControl::Quantizer(_) => eAVEncCommonRateControlMode_Quality,
        };
        if !settings.set(
            &CODECAPI_AVEncCommonRateControlMode,
            &variant::u32(mode.0 as u32),
        ) && matches!(spec.rate, RateControl::Bitrate(_))
        {
            settings.set(
                &CODECAPI_AVEncCommonRateControlMode,
                &variant::u32(eAVEncCommonRateControlMode_CBR.0 as u32),
            );
        }
        if matches!(spec.rate, RateControl::Quantizer(_)) && !quantizer {
            return Err(CodecError::Unsupported(format!(
                "{} takes no QP",
                transform.name
            )));
        }
        settings.rate(spec.rate);
        let output = video_type(subtype(spec.codec)?, spec.size, spec.fps)?;
        let bits = match spec.rate {
            RateControl::Bitrate(bits) => bits,
            // A nominal rate; the QP decides.
            RateControl::Quantizer(_) => 8_000_000,
        };
        let profile = match spec.codec {
            Codec::Hevc => eAVEncH265VProfile_Main_420_8.0 as u32,
            _ => eAVEncH264VProfile_High.0 as u32,
        };
        // SAFETY: Attribute writes and type negotiation on the MFT we just opened.
        unsafe {
            output.SetUINT32(&MF_MT_AVG_BITRATE, bits).ctx("bitrate")?;
            output
                .SetUINT32(&MF_MT_MPEG2_PROFILE, profile)
                .ctx("profile")?;
            tag_bt709(&output)?;
            transform
                .mft
                .SetOutputType(0, &output, 0)
                .ctx("SetOutputType")?;
            let input = input_type(&transform, spec)?;
            transform
                .mft
                .SetInputType(0, &input, 0)
                .ctx("SetInputType")?;
        }
        transform.start()?;
        Ok(Self {
            transform,
            settings,
            spec: spec.clone(),
            quantizer,
        })
    }

    /// The Annex B parameter sets in the current output type, if the MFT has written them.
    pub fn sequence_header(&self) -> Option<Vec<u8>> {
        // SAFETY: Reads a blob attribute of the current type.
        unsafe {
            let t = self.transform.mft.GetOutputCurrentType(0).ok()?;
            let len = t.GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER).ok()?;
            let mut blob = vec![0u8; len as usize];
            t.GetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &mut blob, None)
                .ok()?;
            Some(blob)
        }
    }

    /// After `MF_E_TRANSFORM_STREAM_CHANGE`: take the MFT's first offered output type.
    pub fn renegotiate(&mut self) -> Result<(), CodecError> {
        // SAFETY: Type negotiation on our MFT.
        unsafe {
            let t = self
                .transform
                .mft
                .GetOutputAvailableType(0, 0)
                .ctx("GetOutputAvailableType")?;
            self.transform
                .mft
                .SetOutputType(0, &t, 0)
                .ctx("SetOutputType")
        }
    }
}

/// NV12 at the encode size, taken from the MFT's own offer when it makes one.
fn input_type(transform: &Transform, spec: &EncodeSpec) -> Result<IMFMediaType, CodecError> {
    for index in 0..32 {
        // SAFETY: Enumerates offered types until the MFT runs out.
        let Ok(offered) = (unsafe { transform.mft.GetInputAvailableType(0, index) }) else {
            break;
        };
        if unsafe { offered.GetGUID(&MF_MT_SUBTYPE) }.is_ok_and(|s| s == MFVideoFormat_NV12) {
            let t = video_type(MFVideoFormat_NV12, spec.size, spec.fps)?;
            // SAFETY: Copies the offer, then overrides size and rate.
            unsafe {
                offered.CopyAllItems(&t).ctx("CopyAllItems")?;
                t.SetUINT64(
                    &MF_MT_FRAME_SIZE,
                    super::mft::pack(spec.size.width, spec.size.height),
                )
                .ctx("frame size")?;
                t.SetUINT64(&MF_MT_FRAME_RATE, super::mft::pack(spec.fps, 1))
                    .ctx("frame rate")?;
            }
            tag_bt709(&t)?;
            return Ok(t);
        }
    }
    let t = video_type(MFVideoFormat_NV12, spec.size, spec.fps)?;
    tag_bt709(&t)?;
    Ok(t)
}
