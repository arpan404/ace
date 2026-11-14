// SPDX-License-Identifier: Apache-2.0
//! JPEG on the GPU where the driver lists `VAProfileJPEGBaseline` (Intel iHD decodes and
//! encodes; Mesa decodes on most AMD parts): media-codec's [`JpegCodec`]. Decoding fills
//! VA's JPEG buffers from [`crate::jpeg::parse`]; encoding gives the driver the Annex K tables
//! already scaled to the quality, so a driver that writes its own headers and one that leaves
//! them to us produce the same file.
use super::device::{Buffer, Coded, Config, Context, Device};
use super::ffi::*;
use super::surface::{Surface, SurfacePool};
use super::vpp::VaScaler;
use crate::formats::{NV12, VA_RT_FORMAT_YUV420};
use crate::jpeg::{self, Header};
use crate::select::{self, entrypoint, profile};
use media_codec::{CodecError, JpegCodec, Picture, PixelFormat, Size};
use std::sync::Arc;

/// A config with its context at one size.
struct Pipe {
    size: Size,
    // Drop order: the coded buffer, the context, then the config.
    coded: Option<Buffer>,
    coded_bytes: usize,
    context: Context,
    _config: Config,
}

/// Coded bytes for a JPEG of `size`: 1.5 bytes per pixel, up to 4 after an overflow.
fn jpeg_capacity(size: Size, most: bool) -> usize {
    let pixels = size.width as usize * size.height as usize;
    (pixels * if most { 8 } else { 3 } / 2).max(1 << 16) + 4096
}

pub struct VaJpegCodec {
    device: Arc<Device>,
    can_decode: bool,
    can_encode: bool,
    decode: Option<Pipe>,
    encode: Option<Pipe>,
    decoded: Option<SurfacePool>,
    scaler: Option<VaScaler>,
}

impl VaJpegCodec {
    pub fn new(device: &Arc<Device>) -> Result<Self, CodecError> {
        let listed = device.profiles()?;
        let can_decode = select::lists(&listed, profile::JPEG_BASELINE, entrypoint::VLD);
        let can_encode = select::lists(&listed, profile::JPEG_BASELINE, entrypoint::ENC_PICTURE);
        if !can_decode && !can_encode {
            return Err(CodecError::Unsupported("driver lists no VA JPEG".into()));
        }
        Ok(Self {
            device: Arc::clone(device),
            can_decode,
            can_encode,
            decode: None,
            encode: None,
            decoded: None,
            scaler: None,
        })
    }

    pub fn can_decode(&self) -> bool {
        self.can_decode
    }

    pub fn can_encode(&self) -> bool {
        self.can_encode
    }

    fn pipe(
        device: &Arc<Device>,
        slot: &mut Option<Pipe>,
        entry: i32,
        size: Size,
        targets: &mut [VASurfaceID],
    ) -> Result<(), CodecError> {
        if slot.as_ref().is_some_and(|p| p.size == size) {
            return Ok(());
        }
        *slot = None;
        let config = device.create_config(
            profile::JPEG_BASELINE,
            entry,
            &[(attrib::RT_FORMAT, VA_RT_FORMAT_YUV420)],
        )?;
        let context = device.create_context(&config, size, targets)?;
        let coded_bytes = jpeg_capacity(size, false);
        let coded = if entry == entrypoint::ENC_PICTURE {
            Some(device.empty(&context, buffer::ENC_CODED, coded_bytes)?)
        } else {
            None
        };
        *slot = Some(Pipe {
            size,
            coded,
            coded_bytes,
            context,
            _config: config,
        });
        Ok(())
    }

    fn scaler(&mut self) -> Result<&mut VaScaler, CodecError> {
        if self.scaler.is_none() {
            self.scaler = Some(VaScaler::new(&self.device)?);
        }
        self.scaler
            .as_mut()
            .ok_or_else(|| CodecError::Backend("VA video processing unavailable".into()))
    }

    fn decode_into(&mut self, jpeg: &[u8], h: &Header) -> Result<Surface, CodecError> {
        let size = Size {
            width: u32::from(h.width),
            height: u32::from(h.height),
        };
        size.validate()?;
        if h.rt_format() != Some(VA_RT_FORMAT_YUV420)
            || !size.width.is_multiple_of(2)
            || !size.height.is_multiple_of(2)
        {
            return Err(CodecError::Unsupported(
                "VA JPEG decode here takes 4:2:0 at even sizes".into(),
            ));
        }
        if self.decoded.as_ref().is_none_or(|p| p.size() != size) {
            self.decoded = Some(SurfacePool::new(&self.device, NV12, size)?);
        }
        let surface = self
            .decoded
            .as_ref()
            .ok_or(CodecError::NotConfigured)?
            .take()?;
        Self::pipe(
            &self.device,
            &mut self.decode,
            entrypoint::VLD,
            size,
            &mut [],
        )?;
        let pipe = self.decode.as_ref().ok_or(CodecError::NotConfigured)?;
        let d = &self.device;
        let ctx = &pipe.context;

        let mut pic: VAPictureParameterBufferJPEGBaseline = zeroed();
        pic.picture_width = h.width;
        pic.picture_height = h.height;
        for (slot, c) in pic.components.iter_mut().zip(&h.components) {
            *slot = JPEGComponent {
                component_id: c.id,
                h_sampling_factor: c.h,
                v_sampling_factor: c.v,
                quantiser_table_selector: c.quant,
            };
        }
        pic.num_components = h.components.len() as u8;
        let mut iq: VAIQMatrixBufferJPEGBaseline = zeroed();
        for (i, table) in h.quant.iter().enumerate() {
            if let Some(t) = table {
                iq.load_quantiser_table[i] = 1;
                iq.quantiser_table[i] = *t;
            }
        }
        let mut huffman: VAHuffmanTableBufferJPEGBaseline = zeroed();
        for i in 0..2 {
            huffman.load_huffman_table[i] = 1;
            let t = &mut huffman.huffman_table[i];
            t.num_dc_codes = h.dc[i].counts;
            let n = h.dc[i].symbols.len().min(12);
            t.dc_values[..n].copy_from_slice(&h.dc[i].symbols[..n]);
            t.num_ac_codes = h.ac[i].counts;
            let n = h.ac[i].symbols.len().min(162);
            t.ac_values[..n].copy_from_slice(&h.ac[i].symbols[..n]);
        }
        let scan = &jpeg[h.scan_data.clone()];
        let mut slice = VASliceParameterBufferJPEGBaseline {
            slice_data_size: scan.len() as u32,
            slice_data_flag: VA_SLICE_DATA_FLAG_ALL,
            num_components: h.scan.len() as u8,
            restart_interval: h.restart_interval,
            num_mcus: h.mcu_count(),
            ..Default::default()
        };
        for (slot, c) in slice.components.iter_mut().zip(&h.scan) {
            *slot = JPEGScanComponent {
                component_selector: c.selector,
                dc_table_selector: c.dc,
                ac_table_selector: c.ac,
            };
        }
        let buffers = [
            d.param(ctx, buffer::PICTURE_PARAMETER, &pic)?,
            d.param(ctx, buffer::IQ_MATRIX, &iq)?,
            d.param(ctx, buffer::HUFFMAN_TABLE, &huffman)?,
            d.param(ctx, buffer::SLICE_PARAMETER, &slice)?,
            d.data(ctx, buffer::SLICE_DATA, scan)?,
        ];
        d.submit(ctx, surface.id(), &buffers.iter().collect::<Vec<_>>())?;
        Ok(surface)
    }

    fn encode_surface(
        &mut self,
        input: VASurfaceID,
        size: Size,
        quality: u8,
    ) -> Result<Vec<u8>, CodecError> {
        Self::pipe(
            &self.device,
            &mut self.encode,
            entrypoint::ENC_PICTURE,
            size,
            &mut [],
        )?;
        let pipe = self.encode.as_ref().ok_or(CodecError::NotConfigured)?;
        let coded = pipe.coded.as_ref().ok_or(CodecError::NotConfigured)?;
        let d = &self.device;
        let ctx = &pipe.context;
        let (w, h) = (size.width as u16, size.height as u16);
        let pic = VAEncPictureParameterBufferJPEG {
            reconstructed_picture: input,
            picture_width: w,
            picture_height: h,
            coded_buf: coded.id,
            pic_flags: pack(jpeg_pic::LAYOUT, &[(jpeg_pic::HUFFMAN, 1)]),
            sample_bit_depth: 8,
            num_scan: 1,
            num_components: 3,
            component_id: [1, 2, 3, 0],
            quantiser_table_selector: [0, 1, 1, 0],
            // The tables are already scaled; 50 asks the driver not to scale them again.
            quality: 50,
            ..Default::default()
        };
        let qm = VAQMatrixBufferJPEG {
            load_lum_quantiser_matrix: 1,
            load_chroma_quantiser_matrix: 1,
            lum_quantiser_matrix: jpeg::scaled_quant(&jpeg::LUMA_QUANT, quality),
            chroma_quantiser_matrix: jpeg::scaled_quant(&jpeg::CHROMA_QUANT, quality),
            va_reserved: [0; 4],
        };
        let mut huffman: VAHuffmanTableBufferJPEGBaseline = zeroed();
        for (i, (dc, ac)) in [
            (jpeg::dc_luma(), jpeg::ac_luma()),
            (jpeg::dc_chroma(), jpeg::ac_chroma()),
        ]
        .into_iter()
        .enumerate()
        {
            huffman.load_huffman_table[i] = 1;
            let t = &mut huffman.huffman_table[i];
            t.num_dc_codes = dc.counts;
            t.dc_values.copy_from_slice(&dc.symbols);
            t.num_ac_codes = ac.counts;
            t.ac_values.copy_from_slice(&ac.symbols);
        }
        let slice = VAEncSliceParameterBufferJPEG {
            restart_interval: 0,
            num_components: 3,
            components: [
                JPEGScanComponent {
                    component_selector: 1,
                    dc_table_selector: 0,
                    ac_table_selector: 0,
                },
                JPEGScanComponent {
                    component_selector: 2,
                    dc_table_selector: 1,
                    ac_table_selector: 1,
                },
                JPEGScanComponent {
                    component_selector: 3,
                    dc_table_selector: 1,
                    ac_table_selector: 1,
                },
                JPEGScanComponent::default(),
            ],
            va_reserved: [0; 4],
        };
        let buffers = [
            d.param(ctx, buffer::ENC_PICTURE_PARAMETER, &pic)?,
            d.param(ctx, buffer::Q_MATRIX, &qm)?,
            d.param(ctx, buffer::HUFFMAN_TABLE, &huffman)?,
            d.param(ctx, buffer::ENC_SLICE_PARAMETER, &slice)?,
        ];
        d.submit(ctx, input, &buffers.iter().collect::<Vec<_>>())?;
        d.sync(input)?;
        let mut data = Vec::new();
        if d.read_coded(coded, &mut data)? == Coded::Overflow {
            let pipe = self.encode.as_mut().ok_or(CodecError::NotConfigured)?;
            let grown = (pipe.coded_bytes * 2).min(jpeg_capacity(size, true));
            if grown > pipe.coded_bytes {
                pipe.coded = Some(self.device.empty(&pipe.context, buffer::ENC_CODED, grown)?);
                pipe.coded_bytes = grown;
            }
            return Err(CodecError::Backend(
                "the JPEG overflowed the coded buffer".into(),
            ));
        }
        Ok(complete_jpeg(data, w, h, quality))
    }
}

/// A driver may return only the entropy-coded scan; add the headers and EOI it left out.
fn complete_jpeg(data: Vec<u8>, width: u16, height: u16, quality: u8) -> Vec<u8> {
    let mut out = if data.starts_with(&[0xff, 0xd8]) {
        data
    } else {
        let mut with = Vec::with_capacity(data.len() + 700);
        jpeg::write_headers(width, height, quality, &mut with);
        with.extend_from_slice(&data);
        with
    };
    if !out.ends_with(&[0xff, 0xd9]) {
        out.extend_from_slice(&[0xff, 0xd9]);
    }
    out
}

impl JpegCodec for VaJpegCodec {
    /// Decodes on the GPU into an NV12 surface, scaled by VA-VPP when `width`×`height`
    /// differs from the JPEG's size.
    fn decode(&mut self, jpeg: &[u8], width: u32, height: u32) -> Result<Picture, CodecError> {
        if !self.can_decode {
            return Err(CodecError::Unsupported(
                "driver has no VA JPEG decode".into(),
            ));
        }
        let header = jpeg::parse(jpeg)?;
        let decoded = self.decode_into(jpeg, &header)?;
        if decoded.size() == (Size { width, height }) {
            return Ok(decoded.into_picture(0));
        }
        let picture = decoded.into_picture(0);
        let scaled = media_codec::Scaler::scale(self.scaler()?, &picture, width, height)?;
        // The decoded surface goes back to its pool only once VPP has read it.
        if let Picture::Platform(p) = &scaled
            && let Some(s) = Surface::of(p)
        {
            self.device.sync(s.id())?;
        }
        drop(picture);
        Ok(scaled)
    }

    fn encode(&mut self, picture: &Picture, quality: u8) -> Result<Vec<u8>, CodecError> {
        if !self.can_encode {
            return Err(CodecError::Unsupported(
                "driver has no VA JPEG encode".into(),
            ));
        }
        let size = picture.size();
        if size.width > u32::from(u16::MAX) || size.height > u32::from(u16::MAX) {
            return Err(CodecError::InvalidInput(
                "JPEG sides are at most 65535".into(),
            ));
        }
        if let Picture::Platform(p) = picture
            && let Some(s) = Surface::of(p)
            && Arc::ptr_eq(s.device(), &self.device)
            && s.format().pixel == PixelFormat::Nv12
        {
            let id = s.id();
            return self.encode_surface(id, size, quality);
        }
        let scaler = self.scaler()?;
        let source = scaler.surface_for(picture)?;
        let nv12 = if source.format().pixel == PixelFormat::Nv12 {
            None
        } else {
            let out = scaler.output(size)?;
            scaler.process(&source, &out)?;
            Some(out)
        };
        let id = nv12.as_ref().map_or(source.id(), Surface::id);
        // The upload and the VPP output stay out of their pools until the encode has synced.
        let result = self.encode_surface(id, size, quality);
        drop((nv12, source));
        result
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn a_scan_without_headers_becomes_a_whole_jpeg() {
        let jpeg = complete_jpeg(vec![0x12, 0x34], 64, 32, 85);
        let h = jpeg::parse(&jpeg).unwrap();
        assert_eq!((h.width, h.height), (64, 32));
        assert_eq!(&jpeg[h.scan_data.clone()], [0x12, 0x34]);
        assert!(jpeg.ends_with(&[0xff, 0xd9]));
        let whole = complete_jpeg(jpeg.clone(), 64, 32, 85);
        assert_eq!(whole, jpeg);
    }
}
