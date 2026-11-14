// SPDX-License-Identifier: Apache-2.0
use crate::dec_abi::*;
use crate::decoder::NvDecoder;
use crate::fake::{self, dec};
use media_codec::{BitstreamFormat, Codec, CodecError, Decoder, EncodedUnit, Picture, Size};

fn decoder(codec: Codec, output: Option<Size>) -> Result<NvDecoder, CodecError> {
    let cuvid = fake::cuvid_api(if codec == Codec::Hevc {
        CUVID_HEVC
    } else {
        CUVID_H264
    });
    NvDecoder::with_apis(fake::cuda_api(), cuvid, codec, output)
}

fn unit(codec: Codec, pts: u64) -> EncodedUnit {
    EncodedUnit {
        codec,
        size: Size {
            width: 1280,
            height: 720,
        },
        format: BitstreamFormat::AnnexB,
        data: vec![0, 0, 0, 1, 0x65, 1, 2, 3],
        key: true,
        description: None,
        pts_us: pts,
        duration_us: 16_666,
    }
}

const STILL: Size = Size {
    width: 640,
    height: 360,
};

#[allow(clippy::unnecessary_cast)] // `c_ulong` is 32-bit on Windows
#[test]
fn a_picture_comes_back_at_the_requested_size_scaled_by_the_decoder() {
    let mut decoder = decoder(Codec::H264, Some(STILL)).unwrap();
    let Some(Picture::Cpu(picture)) = decoder.decode(&unit(Codec::H264, 42)).unwrap() else {
        panic!("expected a CPU picture");
    };
    assert_eq!(picture.size(), STILL);
    assert_eq!(picture.pts_us, 42);
    let created = dec(|d| d.created.clone());
    assert_eq!(created.len(), 1);
    assert_eq!(created[0].coded, (1280, 736));
    assert_eq!(created[0].target, (640, 360), "NVDEC does the scaling");
    assert_eq!(created[0].output_format, SURFACE_NV12);
    assert_eq!(created[0].deinterlace, DEINTERLACE_WEAVE);
    assert_eq!(created[0].creation_flags, CREATE_PREFER_CUVID as u64);
    assert!(created[0].surfaces >= 4);
}

#[test]
fn the_readback_takes_luma_then_chroma_from_after_the_surfaces_luma_rows() {
    let mut decoder = decoder(Codec::Hevc, Some(STILL)).unwrap();
    let Some(Picture::Cpu(picture)) = decoder.decode(&unit(Codec::Hevc, 0)).unwrap() else {
        panic!("expected a CPU picture");
    };
    let planes = picture.planes();
    assert_eq!(planes[0].data.len(), 640 * 360);
    assert!(planes[0].data.iter().all(|b| *b == 0x11));
    assert_eq!(planes[1].data.len(), 640 * 180);
    assert!(planes[1].data.iter().all(|b| *b == 0x22));
    assert_eq!(dec(|d| d.copies), 2, "one readback: two plane copies");
    assert_eq!(dec(|d| d.mapped), 0, "the surface is unmapped again");
}

#[test]
fn without_an_output_size_pictures_come_back_at_the_display_size() {
    let mut decoder = decoder(Codec::H264, None).unwrap();
    let picture = decoder.decode(&unit(Codec::H264, 0)).unwrap().unwrap();
    assert_eq!(
        picture.size(),
        Size {
            width: 1280,
            height: 720
        }
    );
}

#[test]
fn later_units_reuse_the_decoder_and_parse_with_the_context_current() {
    let mut decoder = decoder(Codec::H264, Some(STILL)).unwrap();
    for pts in 0..3 {
        assert!(decoder.decode(&unit(Codec::H264, pts)).unwrap().is_some());
    }
    assert_eq!(dec(|d| d.created.len()), 1);
    assert!(dec(|d| d.depth_at_parse.iter().all(|depth| *depth == 1)));
    assert_eq!(dec(|d| d.depth), 0, "no context is left current");
}

#[test]
fn a_stream_this_gpu_cannot_decode_is_unsupported() {
    let mut decoder = decoder(Codec::H264, Some(STILL)).unwrap();
    dec(|d| d.supported = false);
    assert!(matches!(
        decoder.decode(&unit(Codec::H264, 0)),
        Err(CodecError::Unsupported(_))
    ));
    assert_eq!(dec(|d| d.decoders), 0);
}

#[test]
fn ten_bit_and_four_four_four_streams_are_unsupported() {
    for change in [
        |f: &mut VideoFormat| f.bit_depth_luma_minus8 = 2,
        |f: &mut VideoFormat| f.chroma_format = 3,
    ] {
        let mut decoder = decoder(Codec::Hevc, None).unwrap();
        dec(|d| change(d.format.as_mut().unwrap()));
        assert!(matches!(
            decoder.decode(&unit(Codec::Hevc, 0)),
            Err(CodecError::Unsupported(_))
        ));
    }
}

#[test]
fn length_prefixed_units_and_other_codecs_are_refused() {
    let mut decoder = decoder(Codec::H264, None).unwrap();
    let avcc = EncodedUnit {
        format: BitstreamFormat::Avcc,
        ..unit(Codec::H264, 0)
    };
    assert!(matches!(
        decoder.decode(&avcc),
        Err(CodecError::Unsupported(_))
    ));
    assert!(matches!(
        decoder.decode(&unit(Codec::Hevc, 0)),
        Err(CodecError::InvalidInput(_))
    ));
    assert!(matches!(
        NvDecoder::with_apis(
            fake::cuda_api(),
            fake::cuvid_api(CUVID_H264),
            Codec::Vp9,
            None
        ),
        Err(CodecError::Unsupported(_))
    ));
    assert!(matches!(
        NvDecoder::with_apis(
            fake::cuda_api(),
            fake::cuvid_api(CUVID_H264),
            Codec::H264,
            Some(Size {
                width: 641,
                height: 360
            })
        ),
        Err(CodecError::InvalidInput(_))
    ));
}

#[test]
fn dropping_the_decoder_releases_parser_decoder_and_context() {
    let mut decoder = decoder(Codec::H264, Some(STILL)).unwrap();
    decoder.decode(&unit(Codec::H264, 0)).unwrap();
    drop(decoder);
    let calls = dec(|d| d.calls.clone());
    let tail: Vec<_> = calls.iter().rev().take(2).rev().copied().collect();
    assert_eq!(tail, ["destroy_parser", "destroy_decoder"]);
    assert_eq!(dec(|d| (d.parsers, d.decoders, d.contexts)), (0, 0, 0));
}
