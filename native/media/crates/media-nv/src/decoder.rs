// SPDX-License-Identifier: Apache-2.0
//! `Decoder` over NVDEC: H.264 and HEVC Annex B, decoded at the requested output size by the
//! decoder itself, then one readback of the scaled NV12 picture (ADR 0148 §6). NVDEC's JPEG
//! decoder is hybrid CUDA + CPU and is never used.
//!
//! NVIDIA's parser drives the decode: `cuvidParseVideoData` calls back, on this thread, for
//! the sequence (create the decoder), each picture (decode it) and each displayable picture
//! (map, read back, unmap). With no display delay and one picture per packet, the picture of a
//! unit comes back from the same `decode` call.
#![allow(unsafe_code)]
use crate::cuda::CudaContext;
use crate::dec_abi::*;
use crate::error::cuda;
use crate::load::{CudaApi, CuvidApi, NvRuntime};
use media_codec::{
    BitstreamFormat, Codec, CodecError, CpuPicture, Decoder, EncodedUnit, Picture, PixelFormat,
    Plane, Size,
};
use std::collections::VecDeque;
use std::ffi::{c_int, c_ulong, c_void};
use std::ptr::null_mut;
use std::sync::Arc;

/// Pictures in flight between NVDEC and the readback.
const OUTPUT_SURFACES: c_ulong = 2;

struct State {
    cuda: Arc<CudaApi>,
    cuvid: Arc<CuvidApi>,
    decoder: *mut c_void,
    target: Option<Size>,
    out: Size,
    coded: (u32, u32),
    max: Size,
    ready: VecDeque<CpuPicture>,
    error: Option<CodecError>,
}

pub struct NvDecoder {
    codec: Codec,
    parser: *mut c_void,
    state: Box<State>,
    context: CudaContext,
}

// SAFETY: the parser, decoder and context are used one call at a time through `&mut self`,
// with the context pushed for the call; none is tied to the thread that created it.
unsafe impl Send for NvDecoder {}

impl NvDecoder {
    /// A decoder for `codec`. With `output`, every picture comes back at exactly that size,
    /// scaled by NVDEC; without, at the stream's display size.
    pub fn new(
        runtime: &NvRuntime,
        codec: Codec,
        output: Option<Size>,
    ) -> Result<Self, CodecError> {
        let (Some(cuda_api), Some(cuvid_api)) = (runtime.cuda.clone(), runtime.cuvid.clone())
        else {
            return Err(CodecError::Unsupported("no NVDEC on this machine".into()));
        };
        Self::with_apis(cuda_api, cuvid_api, codec, output)
    }

    pub(crate) fn with_apis(
        cuda_api: Arc<CudaApi>,
        cuvid_api: Arc<CuvidApi>,
        codec: Codec,
        output: Option<Size>,
    ) -> Result<Self, CodecError> {
        let codec_type = match codec {
            Codec::H264 => CUVID_H264,
            Codec::Hevc => CUVID_HEVC,
            other => {
                return Err(CodecError::Unsupported(format!(
                    "NVDEC is used for H.264 and HEVC only, not {other:?}"
                )));
            }
        };
        if let Some(size) = output {
            size.validate()?;
            if !size.width.is_multiple_of(2) || !size.height.is_multiple_of(2) {
                return Err(CodecError::InvalidInput(
                    "NV12 output needs even dimensions".into(),
                ));
            }
        }
        let context = CudaContext::create(cuda_api.clone())?;
        let mut state = Box::new(State {
            cuda: cuda_api,
            cuvid: cuvid_api,
            decoder: null_mut(),
            target: output,
            out: Size {
                width: 0,
                height: 0,
            },
            coded: (0, 0),
            max: Size {
                width: 0,
                height: 0,
            },
            ready: VecDeque::new(),
            error: None,
        });
        let mut params: ParserParams = crate::enc_abi::zeroed();
        params.codec = codec_type;
        params.max_num_decode_surfaces = 1;
        params.clock_rate = 1_000_000;
        params.max_display_delay = 0;
        params.user_data = (&mut *state as *mut State).cast();
        params.sequence = Some(on_sequence);
        params.decode = Some(on_decode);
        params.display = Some(on_display);
        let mut parser = null_mut();
        let create = state.cuvid.fns.create_parser;
        // SAFETY: `params` is ours; `user_data` points at the boxed state, which outlives the
        // parser (destroyed first in `Drop`).
        cuda("cuvidCreateVideoParser", unsafe {
            create(&mut parser, &mut params)
        })?;
        Ok(Self {
            codec,
            parser,
            state,
            context,
        })
    }
}

impl NvDecoder {
    /// The largest coded picture this GPU's NVDEC decodes for the codec, known once a sequence
    /// has been seen.
    pub fn max(&self) -> Size {
        self.state.max
    }
}

impl Decoder for NvDecoder {
    fn decode(&mut self, unit: &EncodedUnit) -> Result<Option<Picture>, CodecError> {
        if unit.codec != self.codec {
            return Err(CodecError::InvalidInput(format!(
                "decoder is {:?}, unit is {:?}",
                self.codec, unit.codec
            )));
        }
        if matches!(unit.format, BitstreamFormat::Avcc | BitstreamFormat::Hvcc) {
            return Err(CodecError::Unsupported(
                "NVDEC's parser takes Annex B".into(),
            ));
        }
        let mut packet: SourcePacket = crate::enc_abi::zeroed();
        packet.flags = PKT_TIMESTAMP | PKT_ENDOFPICTURE;
        packet.payload_size = c_ulong::try_from(unit.data.len())
            .map_err(|_| CodecError::InvalidInput("unit too large".into()))?;
        packet.payload = unit.data.as_ptr();
        packet.timestamp = i64::try_from(unit.pts_us).unwrap_or(i64::MAX);
        let parse = self.state.cuvid.fns.parse_data;
        let parser = self.parser;
        // SAFETY: the parser is ours; `packet` borrows `unit.data` for the call only. The
        // callbacks it makes run on this thread, inside this call, with the context pushed.
        let result = self
            .context
            .with(|| unsafe { parse(parser, &mut packet) })?;
        if let Some(error) = self.state.error.take() {
            self.state.ready.clear();
            return Err(error);
        }
        cuda("cuvidParseVideoData", result)?;
        Ok(self.state.ready.pop_front().map(Picture::Cpu))
    }
}

impl Drop for NvDecoder {
    fn drop(&mut self) {
        let parser = self.parser;
        let state = &mut *self.state;
        // SAFETY: parser first (it calls into the state), then the decoder, with the context
        // current; the context itself is dropped after this.
        let _ = self.context.with(|| unsafe {
            if !parser.is_null() {
                (state.cuvid.fns.destroy_parser)(parser);
            }
            if !state.decoder.is_null() {
                (state.cuvid.fns.destroy_decoder)(state.decoder);
                state.decoder = null_mut();
            }
        });
    }
}

fn even(value: c_int) -> u32 {
    (value.max(0) as u32) & !1
}

impl State {
    /// A new or changed sequence: (re)create the decoder at the output size. Returns the
    /// number of decode surfaces for the parser.
    fn sequence(&mut self, format: &VideoFormat) -> Result<c_int, CodecError> {
        if format.chroma_format != CHROMA_420
            || format.bit_depth_luma_minus8 != 0
            || format.bit_depth_chroma_minus8 != 0
        {
            return Err(CodecError::Unsupported(
                "NVDEC path is 8-bit 4:2:0 only".into(),
            ));
        }
        let surfaces = c_int::from(format.min_num_decode_surfaces.max(1));
        let coded = (format.coded_width, format.coded_height);
        if !self.decoder.is_null() && self.coded == coded {
            return Ok(surfaces);
        }
        self.destroy_decoder();
        let mut caps: DecodeCaps = crate::enc_abi::zeroed();
        caps.codec = format.codec;
        caps.chroma_format = CHROMA_420;
        // SAFETY: documented signature; `caps` is ours with its inputs set.
        cuda("cuvidGetDecoderCaps", unsafe {
            (self.cuvid.fns.get_decoder_caps)(&mut caps)
        })?;
        if caps.is_supported == 0 || coded.0 > caps.max_width || coded.1 > caps.max_height {
            return Err(CodecError::Unsupported(format!(
                "this GPU's NVDEC can't decode {}x{}",
                coded.0, coded.1
            )));
        }
        self.max = Size {
            width: caps.max_width,
            height: caps.max_height,
        };
        let [left, top, right, bottom] = format.display_area;
        let out = self.target.unwrap_or(Size {
            width: even(right - left),
            height: even(bottom - top),
        });
        out.validate()?;
        let mut info: DecodeCreateInfo = crate::enc_abi::zeroed();
        info.width = c_ulong::from(coded.0);
        info.height = c_ulong::from(coded.1);
        info.num_decode_surfaces = surfaces as c_ulong;
        info.codec = format.codec;
        info.chroma_format = CHROMA_420;
        info.creation_flags = CREATE_PREFER_CUVID;
        info.max_width = c_ulong::from(coded.0);
        info.max_height = c_ulong::from(coded.1);
        info.display_area = [left, top, right, bottom].map(|v| v.clamp(0, 0x7fff) as i16);
        info.output_format = SURFACE_NV12;
        info.deinterlace_mode = if format.progressive_sequence != 0 {
            DEINTERLACE_WEAVE
        } else {
            DEINTERLACE_ADAPTIVE
        };
        info.target_width = c_ulong::from(out.width);
        info.target_height = c_ulong::from(out.height);
        info.num_output_surfaces = OUTPUT_SURFACES;
        let mut decoder = null_mut();
        // SAFETY: documented signature; `info` is ours.
        cuda("cuvidCreateDecoder", unsafe {
            (self.cuvid.fns.create_decoder)(&mut decoder, &mut info)
        })?;
        self.decoder = decoder;
        self.coded = coded;
        self.out = out;
        Ok(surfaces)
    }

    fn destroy_decoder(&mut self) {
        if !self.decoder.is_null() {
            // SAFETY: the decoder is ours and no frame of it is mapped.
            unsafe { (self.cuvid.fns.destroy_decoder)(self.decoder) };
            self.decoder = null_mut();
        }
    }

    fn decode(&mut self, picture: *mut c_void) -> Result<(), CodecError> {
        if self.decoder.is_null() {
            return Err(CodecError::Backend("NVDEC picture before sequence".into()));
        }
        // SAFETY: `picture` is the parser's picture parameters for this callback.
        cuda("cuvidDecodePicture", unsafe {
            (self.cuvid.fns.decode_picture)(self.decoder, picture)
        })
    }

    fn display(&mut self, info: &DisplayInfo) -> Result<(), CodecError> {
        let mut proc: ProcParams = crate::enc_abi::zeroed();
        proc.progressive_frame = info.progressive_frame;
        proc.top_field_first = info.top_field_first;
        let mut device_ptr = 0u64;
        let mut pitch = 0u32;
        // SAFETY: documented signature; the index came from the parser for this decoder.
        cuda("cuvidMapVideoFrame", unsafe {
            (self.cuvid.fns.map_frame)(
                self.decoder,
                info.picture_index,
                &mut device_ptr,
                &mut pitch,
                &mut proc,
            )
        })?;
        let picture = self.read_back(device_ptr, pitch as usize, info.timestamp);
        // SAFETY: unmaps what was mapped above.
        let unmapped = cuda("cuvidUnmapVideoFrame", unsafe {
            (self.cuvid.fns.unmap_frame)(self.decoder, device_ptr)
        });
        let picture = picture?;
        unmapped?;
        self.ready.push_back(picture);
        Ok(())
    }

    /// The one readback: luma rows, then the interleaved chroma that NVDEC places after the
    /// output surface's luma rows.
    fn read_back(&self, base: u64, pitch: usize, pts: i64) -> Result<CpuPicture, CodecError> {
        let (w, h) = (self.out.width as usize, self.out.height as usize);
        if pitch < w {
            return Err(CodecError::Backend("NVDEC pitch below width".into()));
        }
        let mut luma = vec![0u8; w * h];
        let mut chroma = vec![0u8; w * (h / 2)];
        self.copy(base, pitch, &mut luma, w, h)?;
        self.copy(base + (pitch * h) as u64, pitch, &mut chroma, w, h / 2)?;
        CpuPicture::new(
            self.out,
            PixelFormat::Nv12,
            [
                Plane {
                    data: luma,
                    stride: w,
                },
                Plane {
                    data: chroma,
                    stride: w,
                },
            ],
            u64::try_from(pts).unwrap_or(0),
        )
    }

    fn copy(
        &self,
        src: u64,
        pitch: usize,
        dst: &mut [u8],
        width: usize,
        rows: usize,
    ) -> Result<(), CodecError> {
        let mut copy: Memcpy2d = crate::enc_abi::zeroed();
        copy.src_memory_type = MEMORY_DEVICE;
        copy.src_device = src;
        copy.src_pitch = pitch;
        copy.dst_memory_type = MEMORY_HOST;
        copy.dst_host = dst.as_mut_ptr().cast();
        copy.dst_pitch = width;
        copy.width_in_bytes = width;
        copy.height = rows;
        // SAFETY: `dst` holds `rows * width` bytes; the source is a mapped NVDEC surface.
        cuda("cuMemcpy2D", unsafe { (self.cuda.fns.memcpy_2d)(&copy) })
    }
}

impl Drop for State {
    fn drop(&mut self) {
        self.destroy_decoder();
    }
}

/// Runs `f` on the state behind the parser's user pointer; a failure is kept for `decode` to
/// return and tells the parser to stop (0).
///
/// # Safety
/// `user` must be the `State` this decoder registered, alive and not otherwise borrowed.
unsafe fn with_state(
    user: *mut c_void,
    f: impl FnOnce(&mut State) -> Result<c_int, CodecError>,
) -> c_int {
    // SAFETY: the caller's contract.
    let Some(state) = (unsafe { user.cast::<State>().as_mut() }) else {
        return 0;
    };
    match f(state) {
        Ok(n) => n,
        Err(error) => {
            state.error.get_or_insert(error);
            0
        }
    }
}

unsafe extern "system" fn on_sequence(user: *mut c_void, format: *mut VideoFormat) -> c_int {
    // SAFETY: the parser passes our user pointer and a valid format for the callback.
    unsafe {
        with_state(user, |state| match format.as_ref() {
            Some(format) => state.sequence(format),
            None => Err(CodecError::Backend("NVDEC sequence without format".into())),
        })
    }
}

unsafe extern "system" fn on_decode(user: *mut c_void, picture: *mut c_void) -> c_int {
    // SAFETY: as above.
    unsafe { with_state(user, |state| state.decode(picture).map(|()| 1)) }
}

unsafe extern "system" fn on_display(user: *mut c_void, info: *mut DisplayInfo) -> c_int {
    // SAFETY: as above; a null info marks the end of the stream.
    unsafe {
        with_state(user, |state| match info.as_ref() {
            Some(info) => state.display(info).map(|()| 1),
            None => Ok(1),
        })
    }
}
