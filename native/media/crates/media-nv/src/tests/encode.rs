// SPDX-License-Identifier: Apache-2.0
use crate::enc_abi::*;
use crate::encoder::{NvEncoder, Preset};
use crate::fake::{self, Live, enc};
use crate::surface::GlTexture;
use media_codec::{
    BitstreamFormat, Codec, CodecError, CpuPicture, EncodeSpec, Encoder, Picture, PixelFormat,
    Plane, PlatformPicture, RateControl, Size,
};

const SIZE: Size = Size {
    width: 64,
    height: 32,
};

fn spec(codec: Codec, rate: RateControl, fps: u32) -> EncodeSpec {
    EncodeSpec {
        codec,
        size: SIZE,
        fps,
        rate,
    }
}

fn h264() -> EncodeSpec {
    spec(Codec::H264, RateControl::Bitrate(2_000_000), 60)
}

fn encoder() -> NvEncoder {
    NvEncoder::with_api(fake::encode_api(), Preset::P3)
}

fn nv12(pts: u64) -> Picture {
    let (w, h) = (SIZE.width as usize, SIZE.height as usize);
    // Each luma row holds its row number; chroma rows hold 200 + row.
    let luma = (0..h).flat_map(|r| vec![r as u8; w]).collect();
    let chroma = (0..h / 2).flat_map(|r| vec![200 + r as u8; w]).collect();
    Picture::Cpu(
        CpuPicture::new(
            SIZE,
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
            pts,
        )
        .unwrap(),
    )
}

fn texture(id: u32, pts: u64) -> Picture {
    Picture::Platform(PlatformPicture {
        size: SIZE,
        format: PixelFormat::Bgra8,
        pts_us: pts,
        surface: Box::new(GlTexture::new(id, 0x0DE1, Box::new(()))),
    })
}

fn drain(encoder: &mut NvEncoder) -> Vec<media_codec::EncodedUnit> {
    std::iter::from_fn(|| encoder.poll()).collect()
}

#[test]
fn a_session_opens_in_the_documented_order_with_ultra_low_latency_settings() {
    let mut encoder = encoder();
    encoder.configure(&h264()).unwrap();
    assert_eq!(
        enc(|e| e.calls.clone()),
        [
            "open",
            "guid_count",
            "guids",
            "caps",
            "caps",
            "preset_config",
            "initialize",
            "create_bitstream"
        ]
    );
    let init = enc(|e| e.init.clone()).unwrap();
    assert_eq!(init.codec, CODEC_H264);
    assert_eq!(init.preset, Preset::P3.guid());
    assert_eq!(init.tuning, TUNING_ULTRA_LOW_LATENCY);
    assert_eq!((init.width, init.height, init.fps), (64, 32, 60));
    assert_eq!(init.gop, INFINITE_GOP, "no periodic keyframes");
    assert_eq!(init.idr_period, INFINITE_GOP, "no periodic IDR");
    assert_eq!(init.p_interval, 1, "no B-frames");
    assert_eq!(init.rc_mode, RC_CBR);
    assert_eq!(init.bitrate, 2_000_000);
    assert_eq!(init.ptd, 1, "NVENC decides picture types");
}

#[test]
fn the_first_picture_is_an_idr_with_parameter_sets_then_p_pictures_follow() {
    let mut encoder = encoder();
    encoder.configure(&h264()).unwrap();
    for pts in [0, 16_666, 33_333] {
        encoder.encode(nv12(pts), false).unwrap();
    }
    let units = drain(&mut encoder);
    assert_eq!(
        units.iter().map(|u| u.key).collect::<Vec<_>>(),
        [true, false, false]
    );
    assert_eq!(
        units.iter().map(|u| u.pts_us).collect::<Vec<_>>(),
        [0, 16_666, 33_333]
    );
    assert!(units.iter().all(|u| u.format == BitstreamFormat::AnnexB));
    assert_eq!(units[0].data[..5], [0, 0, 0, 1, 0x65]);
    assert_eq!(units[0].duration_us, 16_666);
    assert_eq!(
        enc(|e| e.pic_flags.clone()),
        [PIC_FLAG_FORCEIDR | PIC_FLAG_OUTPUT_SPSPPS, 0, 0]
    );
}

#[test]
fn a_keyframe_on_request_is_an_idr_with_parameter_sets() {
    let mut encoder = encoder();
    encoder.configure(&h264()).unwrap();
    encoder.encode(nv12(0), false).unwrap();
    encoder.encode(nv12(1), false).unwrap();
    encoder.encode(nv12(2), true).unwrap();
    let keys: Vec<_> = drain(&mut encoder).iter().map(|u| u.key).collect();
    assert_eq!(keys, [true, false, true]);
}

#[test]
fn a_bitrate_change_reconfigures_the_running_stream_without_a_keyframe() {
    let mut encoder = encoder();
    encoder.configure(&h264()).unwrap();
    encoder.encode(nv12(0), false).unwrap();
    encoder
        .configure(&spec(Codec::H264, RateControl::Bitrate(500_000), 30))
        .unwrap();
    encoder.encode(nv12(1), false).unwrap();
    let units = drain(&mut encoder);
    assert!(!units[1].key);
    assert_eq!(units[1].duration_us, 33_333);
    let calls = enc(|e| e.calls.clone());
    assert_eq!(calls.iter().filter(|c| **c == "open").count(), 1);
    let reconfigured = enc(|e| e.reconfigured.clone());
    assert_eq!(reconfigured.len(), 1);
    assert_eq!(reconfigured[0].bitrate, 500_000);
    assert_eq!(reconfigured[0].vbv, 500_000 / 30);
    assert_eq!(reconfigured[0].fps, 30);
    assert_eq!(reconfigured[0].gop, INFINITE_GOP);
}

#[test]
fn a_quantizer_is_constant_qp() {
    let mut encoder = encoder();
    encoder
        .configure(&spec(Codec::Hevc, RateControl::Quantizer(28), 60))
        .unwrap();
    let init = enc(|e| e.init.clone()).unwrap();
    assert_eq!(init.codec, CODEC_HEVC);
    assert_eq!(init.rc_mode, RC_CONSTQP);
    assert_eq!(init.qp.intra, 28);
    assert_eq!(init.idr_period, INFINITE_GOP);
}

#[test]
fn a_failed_rate_change_keeps_the_previous_configuration() {
    let mut encoder = encoder();
    encoder
        .configure(&spec(Codec::H264, RateControl::Bitrate(1_000_000), 30))
        .unwrap();
    enc(|e| e.fail = Some(("reconfigure", 8)));
    let changed = spec(Codec::H264, RateControl::Bitrate(9_000_000), 60);
    assert!(matches!(
        encoder.configure(&changed),
        Err(CodecError::InvalidInput(_))
    ));
    encoder.encode(nv12(0), false).unwrap();
    assert_eq!(drain(&mut encoder)[0].duration_us, 33_333);
}

#[test]
fn a_size_change_opens_a_new_session_that_starts_at_a_keyframe() {
    let mut encoder = encoder();
    encoder.configure(&h264()).unwrap();
    encoder.encode(nv12(0), false).unwrap();
    encoder.encode(nv12(1), false).unwrap();
    let bigger = EncodeSpec {
        size: Size {
            width: 128,
            height: 64,
        },
        ..h264()
    };
    encoder.configure(&bigger).unwrap();
    assert_eq!(enc(|e| e.live.sessions), 1, "the old session is destroyed");
    let picture = Picture::Cpu(
        CpuPicture::new(
            bigger.size,
            PixelFormat::Bgra8,
            [Plane {
                data: vec![0; 128 * 64 * 4],
                stride: 512,
            }],
            2,
        )
        .unwrap(),
    );
    encoder.encode(picture, false).unwrap();
    assert_eq!(drain(&mut encoder).last().map(|u| u.key), Some(true));
    assert_eq!(enc(|e| e.pic_formats.last().copied()), Some(FORMAT_ARGB));
}

#[test]
fn cpu_pictures_are_uploaded_row_by_row_at_the_drivers_pitch() {
    let mut encoder = encoder();
    encoder.configure(&h264()).unwrap();
    encoder.encode(nv12(0), false).unwrap();
    let (input, pitch) = enc(|e| (e.input.clone(), e.input_pitch as usize));
    assert!(pitch > SIZE.width as usize);
    for row in 0..32 {
        assert_eq!(input[row * pitch], row as u8);
        assert_eq!(input[row * pitch + 63], row as u8);
        assert_eq!(input[row * pitch + 64], 0, "padding untouched");
    }
    for row in 0..16 {
        assert_eq!(input[(32 + row) * pitch], 200 + row as u8);
    }
    assert_eq!(enc(|e| e.pic_formats.clone()), [FORMAT_NV12]);
}

#[test]
fn gl_textures_are_registered_once_and_mapped_for_each_picture() {
    let mut encoder = encoder();
    encoder.configure(&h264()).unwrap();
    for pts in 0..3 {
        encoder.encode(texture(7, pts), false).unwrap();
    }
    encoder.encode(texture(8, 3), false).unwrap();
    let calls = enc(|e| e.calls.clone());
    assert_eq!(calls.iter().filter(|c| **c == "register").count(), 2);
    assert_eq!(calls.iter().filter(|c| **c == "map").count(), 4);
    assert_eq!(calls.iter().filter(|c| **c == "unmap").count(), 4);
    assert_eq!(
        enc(|e| e.registered.clone()),
        [
            (RESOURCE_OPENGL_TEX, FORMAT_ARGB, 7),
            (RESOURCE_OPENGL_TEX, FORMAT_ARGB, 8)
        ]
    );
    assert_eq!(enc(|e| e.live.mapped), 0, "nothing stays mapped");
    assert_eq!(drain(&mut encoder).len(), 4);
}

#[test]
fn dropping_the_encoder_ends_the_stream_and_releases_everything_in_order() {
    let mut encoder = encoder();
    encoder.configure(&h264()).unwrap();
    encoder.encode(nv12(0), false).unwrap();
    encoder.encode(texture(3, 1), false).unwrap();
    enc(|e| e.calls.clear());
    drop(encoder);
    assert_eq!(
        enc(|e| e.calls.clone()),
        [
            "eos",
            "destroy_input",
            "destroy_bitstream",
            "unregister",
            "destroy"
        ]
    );
    assert_eq!(enc(|e| e.live), Live::default());
}

#[test]
fn a_gpu_without_the_codec_has_no_encoder_for_it_and_keeps_no_session() {
    let mut encoder = encoder();
    enc(|e| e.guids = vec![CODEC_H264]);
    let hevc = spec(Codec::Hevc, RateControl::Bitrate(1_000_000), 30);
    assert!(matches!(
        encoder.configure(&hevc),
        Err(CodecError::Unsupported(_))
    ));
    assert_eq!(enc(|e| e.live.sessions), 0);
    assert_eq!(
        encoder.encode(nv12(0), false),
        Err(CodecError::NotConfigured)
    );
}

#[test]
fn a_size_above_the_gpus_maximum_is_unsupported() {
    let mut encoder = encoder();
    enc(|e| e.max = (32, 32));
    assert!(matches!(
        encoder.configure(&h264()),
        Err(CodecError::Unsupported(_))
    ));
    assert_eq!(enc(|e| e.live.sessions), 0);
}

#[test]
fn a_driver_that_rejects_the_pinned_structure_versions_means_no_backend() {
    let mut encoder = encoder();
    enc(|e| e.fail = Some(("open", 15)));
    assert!(matches!(
        encoder.configure(&h264()),
        Err(CodecError::Unsupported(_))
    ));
}

#[test]
fn a_busy_encoder_is_backpressure_and_the_keyframe_stays_owed() {
    let mut encoder = encoder();
    encoder.configure(&h264()).unwrap();
    enc(|e| e.fail = Some(("encode", 18)));
    assert_eq!(
        encoder.encode(nv12(0), false),
        Err(CodecError::Backpressure)
    );
    encoder.encode(nv12(1), false).unwrap();
    let units = drain(&mut encoder);
    assert_eq!(units.len(), 1);
    assert!(units[0].key);
}

#[test]
fn pictures_of_another_size_or_an_unsupported_format_are_refused() {
    let mut encoder = encoder();
    encoder.configure(&h264()).unwrap();
    let wrong = Picture::Cpu(
        CpuPicture::new(
            Size {
                width: 32,
                height: 32,
            },
            PixelFormat::Nv12,
            [
                Plane {
                    data: vec![0; 1024],
                    stride: 32,
                },
                Plane {
                    data: vec![0; 512],
                    stride: 32,
                },
            ],
            0,
        )
        .unwrap(),
    );
    assert!(matches!(
        encoder.encode(wrong, false),
        Err(CodecError::InvalidInput(_))
    ));
    let rgb = Picture::Cpu(
        CpuPicture::new(
            SIZE,
            PixelFormat::Rgb8,
            [Plane {
                data: vec![0; 64 * 32 * 3],
                stride: 192,
            }],
            0,
        )
        .unwrap(),
    );
    assert!(matches!(
        encoder.encode(rgb, false),
        Err(CodecError::Unsupported(_))
    ));
    assert!(matches!(
        encoder.configure(&spec(Codec::Vp9, RateControl::Bitrate(1), 30)),
        Err(CodecError::Unsupported(_))
    ));
}
