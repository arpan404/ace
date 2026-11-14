// SPDX-License-Identifier: Apache-2.0
//! The backend against the fake driver: what reaches the driver for each picture, and what
//! comes back to the caller. Real-hardware behaviour is out of reach here (see the PR).
#![allow(clippy::unwrap_used)]
use super::fake::{self, Fake};
use super::ffi::*;
use super::*;
use crate::select::{entrypoint, packed, profile, rc};
use media_bitstream::{avcc::AvcConfig, h264, hevc, hvcc::HevcConfig, nal};
use media_codec::{
    Codec, CodecError, CpuPicture, EncodeSpec, Encoder, JpegCodec, Picture, PixelFormat, Plane,
    RateControl, Scaler, Size,
};
use media_wire::capability::{Backend, Step, TrialState};
use std::os::fd::AsFd;

fn spec(codec: Codec, rate: RateControl) -> EncodeSpec {
    EncodeSpec {
        codec,
        size: Size {
            width: 1280,
            height: 720,
        },
        fps: 60,
        rate,
    }
}

fn nv12(size: Size, value: u8) -> CpuPicture {
    let (w, h) = (size.width as usize, size.height as usize);
    CpuPicture::new(
        size,
        PixelFormat::Nv12,
        [
            Plane {
                data: (0..w * h).map(|i| (i % 200) as u8 ^ value).collect(),
                stride: w,
            },
            Plane {
                data: vec![value; w * h / 2],
                stride: w,
            },
        ],
        7,
    )
    .unwrap()
}

fn bgra(size: Size) -> CpuPicture {
    CpuPicture::new(
        size,
        PixelFormat::Bgra8,
        [Plane {
            data: vec![60; size.width as usize * size.height as usize * 4],
            stride: size.width as usize * 4,
        }],
        9,
    )
    .unwrap()
}

fn misc_type(bytes: &[u8]) -> u32 {
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

fn encoder(fake: Fake) -> (VaEncoder, fake::Shared) {
    let (device, shared) = fake::device(fake);
    (VaEncoder::new(&device).unwrap(), shared)
}

#[test]
fn an_h264_idr_carries_the_sequence_rate_control_and_ace_packed_headers() {
    let (mut enc, shared) = encoder(Fake::intel());
    enc.configure(&spec(Codec::H264, RateControl::Bitrate(6_000_000)))
        .unwrap();
    let session = enc.session().unwrap();
    assert_eq!(session.candidate.profile, profile::H264_HIGH);
    assert_eq!(session.candidate.entrypoint, entrypoint::ENC_SLICE_LP);
    assert_eq!(session.rate_control, rc::CBR);
    assert_eq!(session.packed_headers, packed::SEQUENCE | packed::PICTURE);

    enc.encode(
        Picture::Cpu(nv12(spec(Codec::H264, RateControl::Bitrate(1)).size, 0)),
        false,
    )
    .unwrap();
    let f = shared.lock().unwrap();
    let (_, _, config) = f.configs.last().unwrap();
    assert!(config.contains(&(
        attrib::ENC_PACKED_HEADERS,
        packed::SEQUENCE | packed::PICTURE
    )));
    assert!(config.contains(&(attrib::RATE_CONTROL, rc::CBR)));
    let r = f.rendered.last().unwrap();
    assert_eq!(
        r.kinds(),
        [
            buffer::ENC_SEQUENCE_PARAMETER,
            buffer::ENC_MISC_PARAMETER,
            buffer::ENC_MISC_PARAMETER,
            buffer::ENC_MISC_PARAMETER,
            buffer::ENC_PICTURE_PARAMETER,
            buffer::ENC_PACKED_HEADER_PARAMETER,
            buffer::ENC_PACKED_HEADER_DATA,
            buffer::ENC_PACKED_HEADER_PARAMETER,
            buffer::ENC_PACKED_HEADER_DATA,
            buffer::ENC_SLICE_PARAMETER,
        ]
    );
    let seq: VAEncSequenceParameterBufferH264 = r.get(buffer::ENC_SEQUENCE_PARAMETER, 0);
    assert_eq!(seq.bits_per_second, 6_000_000);
    assert_eq!(
        (seq.picture_width_in_mbs, seq.picture_height_in_mbs),
        (80, 45)
    );
    let rc_bytes = r.bytes(buffer::ENC_MISC_PARAMETER, 0);
    assert_eq!(misc_type(rc_bytes), misc::RATE_CONTROL);
    // SAFETY: the payload after the misc type word is a VAEncMiscParameterRateControl.
    let control: VAEncMiscParameterRateControl =
        unsafe { std::ptr::read_unaligned(rc_bytes[4..].as_ptr().cast()) };
    assert_eq!(
        (control.bits_per_second, control.target_percentage),
        (6_000_000, 100)
    );
    let header: VAEncPackedHeaderParameterBuffer = r.get(buffer::ENC_PACKED_HEADER_PARAMETER, 0);
    let sps = r.bytes(buffer::ENC_PACKED_HEADER_DATA, 0);
    assert_eq!(header.type_, packed_type::SEQUENCE);
    assert_eq!(header.bit_length as usize, sps.len() * 8);
    let parsed = h264::Sps::parse(&sps[4..]).unwrap();
    assert_eq!(parsed.frame_size(), (1280, 720));
    let pic: VAEncPictureParameterBufferH264 = r.get(buffer::ENC_PICTURE_PARAMETER, 0);
    assert_eq!(pic.pic_fields & 1, 1, "idr_pic_flag");
    drop(f);

    let unit = enc.poll().unwrap();
    assert!(unit.key);
    assert_eq!(unit.pts_us, 7);
    let record = AvcConfig::parse(&unit.description.unwrap()).unwrap();
    assert_eq!(record.codec_string(), "avc1.640020");
    assert_eq!(
        nal::h264::unit_type(nal::annex_b_units(&unit.data).next().unwrap()),
        Some(nal::h264::SPS)
    );
    assert!(enc.poll().is_none());
}

#[test]
fn p_pictures_refer_to_the_previous_reconstruction_until_a_key_is_forced() {
    let (mut enc, shared) = encoder(Fake::intel());
    let s = spec(Codec::H264, RateControl::Quantizer(30));
    enc.configure(&s).unwrap();
    for force in [false, false, false, true] {
        enc.encode(Picture::Cpu(nv12(s.size, 1)), force).unwrap();
    }
    let units: Vec<_> = std::iter::from_fn(|| enc.poll()).collect();
    assert_eq!(
        units.iter().map(|u| u.key).collect::<Vec<_>>(),
        [true, false, false, true]
    );
    assert!(units[1].description.is_none());
    let f = shared.lock().unwrap();
    let pics: Vec<VAEncPictureParameterBufferH264> = f
        .rendered
        .iter()
        .map(|r| r.get(buffer::ENC_PICTURE_PARAMETER, 0))
        .collect();
    assert_eq!(
        pics[1].ReferenceFrames[0].picture_id,
        pics[0].CurrPic.picture_id
    );
    assert_eq!(
        pics[2].ReferenceFrames[0].picture_id,
        pics[1].CurrPic.picture_id
    );
    assert_ne!(pics[1].CurrPic.picture_id, pics[0].CurrPic.picture_id);
    assert_eq!(pics[2].frame_num, 2);
    assert!(
        !f.rendered[1]
            .kinds()
            .contains(&buffer::ENC_SEQUENCE_PARAMETER)
    );
    let slices: Vec<VAEncSliceParameterBufferH264> = f
        .rendered
        .iter()
        .map(|r| r.get(buffer::ENC_SLICE_PARAMETER, 0))
        .collect();
    assert_eq!(slices[0].idr_pic_id, 0);
    assert_eq!(slices[3].idr_pic_id, 1);
    // CQP: no rate-control buffer, QP in the PPS.
    assert!(
        f.rendered[0]
            .buffers
            .iter()
            .all(|(k, b)| *k != buffer::ENC_MISC_PARAMETER || misc_type(b) != misc::RATE_CONTROL)
    );
    assert_eq!(pics[0].pic_init_qp, 30);
}

#[test]
fn a_refused_low_power_config_falls_back_to_the_full_encoder() {
    let mut fake = Fake::intel();
    fake.refuse_configs
        .push((profile::H264_HIGH, entrypoint::ENC_SLICE_LP));
    let (mut enc, _) = encoder(fake);
    enc.configure(&spec(Codec::H264, RateControl::Bitrate(1_000_000)))
        .unwrap();
    let c = enc.session().unwrap().candidate;
    assert_eq!(
        (c.profile, c.entrypoint),
        (profile::H264_HIGH, entrypoint::ENC_SLICE)
    );
}

#[test]
fn a_quantizer_stream_without_cqp_is_refused_and_the_old_stream_kept() {
    let mut fake = Fake::intel();
    for v in fake
        .attributes
        .iter_mut()
        .filter(|((_, _, a), _)| *a == attrib::RATE_CONTROL)
    {
        *v.1 = rc::CBR;
    }
    let (mut enc, _) = encoder(fake);
    let bitrate = spec(Codec::Hevc, RateControl::Bitrate(2_000_000));
    enc.configure(&bitrate).unwrap();
    let mut other = spec(Codec::Hevc, RateControl::Quantizer(30));
    other.size.width = 640;
    assert!(matches!(
        enc.configure(&other),
        Err(CodecError::Unsupported(_))
    ));
    enc.encode(Picture::Cpu(nv12(bitrate.size, 2)), false)
        .unwrap();
    assert_eq!(enc.poll().unwrap().size, bitrate.size);
    assert!(!enc.caps().quantizer);
}

#[test]
fn a_rate_change_continues_the_stream_and_resends_rate_control() {
    let (mut enc, shared) = encoder(Fake::intel());
    let mut s = spec(Codec::H264, RateControl::Bitrate(4_000_000));
    enc.configure(&s).unwrap();
    enc.encode(Picture::Cpu(nv12(s.size, 3)), false).unwrap();
    s.rate = RateControl::Bitrate(1_500_000);
    enc.configure(&s).unwrap();
    enc.encode(Picture::Cpu(nv12(s.size, 3)), false).unwrap();
    let units: Vec<_> = std::iter::from_fn(|| enc.poll()).collect();
    assert_eq!(
        units.iter().map(|u| u.key).collect::<Vec<_>>(),
        [true, false]
    );
    let f = shared.lock().unwrap();
    let seq: VAEncSequenceParameterBufferH264 =
        f.rendered[1].get(buffer::ENC_SEQUENCE_PARAMETER, 0);
    assert_eq!(seq.bits_per_second, 1_500_000);
    assert!(
        !f.rendered[1]
            .kinds()
            .contains(&buffer::ENC_PACKED_HEADER_DATA)
    );
}

#[test]
fn after_a_failed_submission_the_next_picture_is_an_idr() {
    let (mut enc, shared) = encoder(Fake::intel());
    let s = spec(Codec::H264, RateControl::Bitrate(2_000_000));
    enc.configure(&s).unwrap();
    enc.encode(Picture::Cpu(nv12(s.size, 4)), false).unwrap();
    shared.lock().unwrap().fail_render = true;
    assert!(matches!(
        enc.encode(Picture::Cpu(nv12(s.size, 4)), false),
        Err(CodecError::Backend(_))
    ));
    shared.lock().unwrap().fail_render = false;
    enc.encode(Picture::Cpu(nv12(s.size, 4)), false).unwrap();
    let keys: Vec<bool> = std::iter::from_fn(|| enc.poll()).map(|u| u.key).collect();
    assert_eq!(keys, [true, true]);
}

#[test]
fn hevc_sends_vps_and_sps_as_sequence_headers_and_describes_the_stream() {
    let (mut enc, shared) = encoder(Fake::intel());
    let s = spec(Codec::Hevc, RateControl::Bitrate(3_000_000));
    enc.configure(&s).unwrap();
    enc.encode(Picture::Cpu(nv12(s.size, 5)), false).unwrap();
    enc.encode(Picture::Cpu(nv12(s.size, 5)), false).unwrap();
    let f = shared.lock().unwrap();
    let r = &f.rendered[0];
    let types: Vec<u8> = (0..3)
        .map(|i| nal::hevc::unit_type(&r.bytes(buffer::ENC_PACKED_HEADER_DATA, i)[4..]).unwrap())
        .collect();
    assert_eq!(types, [nal::hevc::VPS, nal::hevc::SPS, nal::hevc::PPS]);
    let sps = hevc::Sps::parse(&r.bytes(buffer::ENC_PACKED_HEADER_DATA, 1)[4..]).unwrap();
    let seq: VAEncSequenceParameterBufferHEVC = r.get(buffer::ENC_SEQUENCE_PARAMETER, 0);
    assert_eq!(
        u32::from(seq.pic_width_in_luma_samples),
        sps.pic_width_in_luma_samples
    );
    let p: VAEncPictureParameterBufferHEVC = f.rendered[1].get(buffer::ENC_PICTURE_PARAMETER, 0);
    assert_eq!(p.nal_unit_type, nal::hevc::TRAIL_R);
    let slice: VAEncSliceParameterBufferHEVC = f.rendered[1].get(buffer::ENC_SLICE_PARAMETER, 0);
    assert_eq!(
        slice.ref_pic_list0[0].picture_id,
        p.reference_frames[0].picture_id
    );
    drop(f);
    let record = HevcConfig::parse(&enc.poll().unwrap().description.unwrap()).unwrap();
    assert_eq!(record.codec_string(), "hvc1.1.6.L120.B0");
}

#[test]
fn rgb_captures_go_through_vpp_into_the_encoder_input() {
    let (mut enc, shared) = encoder(Fake::intel());
    let s = spec(Codec::H264, RateControl::Bitrate(2_000_000));
    enc.configure(&s).unwrap();
    enc.encode(Picture::Cpu(bgra(s.size)), false).unwrap();
    let f = shared.lock().unwrap();
    let [vpp, encode] = &f.rendered[..] else {
        panic!("{} submissions", f.rendered.len())
    };
    assert_eq!(vpp.kinds(), [buffer::PROC_PIPELINE_PARAMETER]);
    let params: VAProcPipelineParameterBuffer = vpp.get(buffer::PROC_PIPELINE_PARAMETER, 0);
    assert_eq!(params.surface_color_standard, VA_PROC_COLOR_STANDARD_SRGB);
    assert_eq!(
        params.output_color_properties.color_range,
        VA_SOURCE_RANGE_REDUCED
    );
    assert_eq!(
        encode.target, vpp.target,
        "the encoder reads the VPP output"
    );
}

#[test]
fn input_surfaces_are_reused_from_picture_to_picture() {
    let (mut enc, shared) = encoder(Fake::intel());
    let s = spec(Codec::H264, RateControl::Bitrate(2_000_000));
    enc.configure(&s).unwrap();
    enc.encode(Picture::Cpu(nv12(s.size, 6)), false).unwrap();
    let after_first = shared.lock().unwrap().surfaces_created;
    for _ in 0..5 {
        enc.encode(Picture::Cpu(nv12(s.size, 6)), false).unwrap();
    }
    assert_eq!(shared.lock().unwrap().surfaces_created, after_first);
}

#[test]
fn an_upload_reads_back_unchanged() {
    let (device, _) = fake::device(Fake::intel());
    let size = Size {
        width: 64,
        height: 32,
    };
    let picture = nv12(size, 9);
    let surface = Surface::create(&device, crate::formats::NV12, size, 1)
        .unwrap()
        .pop()
        .unwrap();
    surface.upload(&picture).unwrap();
    let back = surface.read(7).unwrap();
    assert_eq!(back, picture);
}

#[test]
fn a_dmabuf_import_hands_the_driver_its_planes_without_a_copy() {
    let (device, shared) = fake::device(Fake::intel());
    let file = std::fs::File::open("/dev/null").unwrap();
    let buf = DmaBuf {
        size: Size {
            width: 1920,
            height: 1080,
        },
        drm_format: crate::formats::DRM_FORMAT_XRGB8888,
        objects: vec![DmaBufObject {
            fd: file.as_fd(),
            size: 1920 * 1080 * 4,
            modifier: 0x0100_0000_0000_0002,
        }],
        planes: vec![DmaBufPlane {
            object: 0,
            offset: 0,
            pitch: 7680,
        }],
    };
    let surface = Surface::import(&device, &buf).unwrap();
    assert_eq!(surface.format(), crate::formats::BGRX);
    let f = shared.lock().unwrap();
    let d = f.imports.last().unwrap();
    assert_eq!(d.fourcc, crate::formats::VA_FOURCC_BGRX);
    assert_eq!((d.num_objects, d.num_layers), (1, 1));
    assert_eq!(d.objects[0].drm_format_modifier, 0x0100_0000_0000_0002);
    assert_eq!(d.layers[0].drm_format, crate::formats::DRM_FORMAT_XRGB8888);
    assert_eq!((d.layers[0].num_planes, d.layers[0].pitch[0]), (1, 7680));
    drop(f);
    let bad = DmaBuf {
        drm_format: crate::formats::fourcc(b"YUYV"),
        ..buf
    };
    assert!(matches!(
        Surface::import(&device, &bad),
        Err(CodecError::Unsupported(_))
    ));
}

#[test]
fn the_scaler_returns_an_nv12_surface_of_the_exact_size() {
    let (device, _) = fake::device(Fake::intel());
    let mut scaler = VaScaler::new(&device).unwrap();
    let out = scaler
        .scale(
            &Picture::Cpu(bgra(Size {
                width: 200,
                height: 100,
            })),
            100,
            50,
        )
        .unwrap();
    let Picture::Platform(p) = out else {
        panic!("CPU output")
    };
    assert_eq!(
        (p.size, p.format, p.pts_us),
        (
            Size {
                width: 100,
                height: 50
            },
            PixelFormat::Nv12,
            9
        )
    );
    assert!(
        scaler
            .scale(
                &Picture::Cpu(bgra(Size {
                    width: 8,
                    height: 8
                })),
                5,
                4
            )
            .is_err()
    );
}

fn cpu_jpeg(size: Size) -> Vec<u8> {
    let rgb = CpuPicture::new(
        size,
        PixelFormat::Rgb8,
        [Plane {
            data: vec![120; size.width as usize * size.height as usize * 3],
            stride: size.width as usize * 3,
        }],
        0,
    )
    .unwrap();
    media_codec::StillCodec::encode(&mut media_codec::CpuJpegCodec::default(), &rgb, 80).unwrap()
}

#[test]
fn jpeg_decode_hands_the_driver_the_files_tables_and_scan() {
    let (device, shared) = fake::device(Fake::intel());
    let mut codec = VaJpegCodec::new(&device).unwrap();
    let size = Size {
        width: 96,
        height: 64,
    };
    let jpeg = cpu_jpeg(size);
    let header = crate::jpeg::parse(&jpeg).unwrap();
    let picture = codec.decode(&jpeg, 96, 64).unwrap();
    assert_eq!(picture.size(), size);
    let f = shared.lock().unwrap();
    let r = f.rendered.last().unwrap();
    assert_eq!(
        r.kinds(),
        [
            buffer::PICTURE_PARAMETER,
            buffer::IQ_MATRIX,
            buffer::HUFFMAN_TABLE,
            buffer::SLICE_PARAMETER,
            buffer::SLICE_DATA
        ]
    );
    let pic: VAPictureParameterBufferJPEGBaseline = r.get(buffer::PICTURE_PARAMETER, 0);
    assert_eq!(
        (pic.picture_width, pic.picture_height, pic.num_components),
        (96, 64, 3)
    );
    assert_eq!(pic.components[0].h_sampling_factor, 2);
    let slice: VASliceParameterBufferJPEGBaseline = r.get(buffer::SLICE_PARAMETER, 0);
    assert_eq!(slice.num_mcus, 6 * 4);
    assert_eq!(r.bytes(buffer::SLICE_DATA, 0), &jpeg[header.scan_data]);
    let iq: VAIQMatrixBufferJPEGBaseline = r.get(buffer::IQ_MATRIX, 0);
    assert_eq!(Some(iq.quantiser_table[0]), header.quant[0]);
}

#[test]
fn jpeg_decode_to_another_size_scales_on_the_gpu() {
    let (device, shared) = fake::device(Fake::intel());
    let mut codec = VaJpegCodec::new(&device).unwrap();
    let picture = codec
        .decode(
            &cpu_jpeg(Size {
                width: 96,
                height: 64,
            }),
            48,
            32,
        )
        .unwrap();
    assert_eq!(
        picture.size(),
        Size {
            width: 48,
            height: 32
        }
    );
    let kinds: Vec<Vec<i32>> = shared
        .lock()
        .unwrap()
        .rendered
        .iter()
        .map(|r| r.kinds())
        .collect();
    assert_eq!(kinds.last().unwrap(), &[buffer::PROC_PIPELINE_PARAMETER]);
}

#[test]
fn jpeg_encode_returns_a_whole_file_when_the_driver_gives_only_the_scan() {
    let mut fake = Fake::intel();
    fake.coded = vec![0x11, 0x22, 0x33];
    let (device, shared) = fake::device(fake);
    let mut codec = VaJpegCodec::new(&device).unwrap();
    let size = Size {
        width: 64,
        height: 48,
    };
    let jpeg = codec.encode(&Picture::Cpu(nv12(size, 1)), 85).unwrap();
    assert_eq!(media_codec::jpeg_size(&jpeg).unwrap(), size);
    let header = crate::jpeg::parse(&jpeg).unwrap();
    assert_eq!(&jpeg[header.scan_data.clone()], [0x11, 0x22, 0x33]);
    let f = shared.lock().unwrap();
    let qm: VAQMatrixBufferJPEG = f.rendered.last().unwrap().get(buffer::Q_MATRIX, 0);
    // The header's tables are the ones the driver was given.
    assert_eq!(Some(qm.lum_quantiser_matrix), header.quant[0]);
    assert_eq!(Some(qm.chroma_quantiser_matrix), header.quant[1]);
}

#[test]
fn a_decode_only_driver_refuses_jpeg_encode() {
    let mut fake = Fake::intel();
    fake.profiles.retain(|(p, _)| *p != profile::JPEG_BASELINE);
    fake.profiles
        .push((profile::JPEG_BASELINE, vec![entrypoint::VLD]));
    let (device, _) = fake::device(fake);
    let mut codec = VaJpegCodec::new(&device).unwrap();
    let r = codec.encode(
        &Picture::Cpu(nv12(
            Size {
                width: 16,
                height: 16,
            },
            0,
        )),
        80,
    );
    assert!(matches!(r, Err(CodecError::Unsupported(_))));
}

#[test]
fn the_trial_reports_every_listed_step_on_hardware() {
    let (device, _) = fake::device(Fake::intel());
    let found = trial_on(&device, &|| false);
    let steps: Vec<(Step, Option<String>)> =
        found.iter().map(|c| (c.step, c.codec.clone())).collect();
    assert_eq!(
        steps,
        [
            (Step::Encode, Some("avc1.640014".into())),
            (Step::Encode, Some("hvc1.1.6.L60.B0".into())),
            (Step::Scale, None),
            (Step::JpegDecode, Some("jpeg".into())),
            (Step::JpegEncode, Some("jpeg".into())),
        ]
    );
    for c in &found {
        assert_eq!(
            (c.backend, c.state, c.hardware),
            (Backend::Vaapi, TrialState::Ok, true),
            "{c:?}"
        );
        assert!(c.max_width > 0);
    }
    assert!(found[0].zero_copy, "encode surfaces import DMA-BUFs");
    assert_eq!(found[0].max_width, 4096);
}

#[test]
fn a_driver_without_encoders_reports_only_what_it_has() {
    let mut fake = Fake::intel();
    fake.profiles.retain(|(p, _)| *p == profile::NONE);
    let (device, _) = fake::device(fake);
    let found = trial_on(&device, &|| false);
    assert_eq!(
        found.iter().map(|c| c.step).collect::<Vec<_>>(),
        [Step::Scale]
    );
    assert!(matches!(
        VaEncoder::new(&device),
        Err(CodecError::Unsupported(_))
    ));
}

#[test]
fn a_cancelled_trial_stops_at_the_next_step_and_reports_the_rest_timed_out() {
    let (device, _) = fake::device(Fake::intel());
    let ran = std::cell::Cell::new(0);
    let found = trial_on(&device, &|| {
        ran.set(ran.get() + 1);
        ran.get() > 1
    });
    let states: Vec<TrialState> = found.iter().map(|c| c.state).collect();
    assert_eq!(
        states,
        [
            TrialState::Ok,
            TrialState::TimedOut,
            TrialState::TimedOut,
            TrialState::TimedOut,
            TrialState::TimedOut
        ]
    );
    assert_eq!(found[1].codec.as_deref(), Some(HEVC_CODEC));
}

#[test]
fn a_failing_step_is_reported_failed_not_dropped() {
    let mut fake = Fake::intel();
    fake.refuse_configs
        .push((profile::HEVC_MAIN, entrypoint::ENC_SLICE_LP));
    let (device, _) = fake::device(fake);
    let hevc = trial_on(&device, &|| false).into_iter().nth(1).unwrap();
    assert_eq!((hevc.step, hevc.state), (Step::Encode, TrialState::Failed));
    assert_eq!(hevc.codec.as_deref(), Some(HEVC_CODEC));
}

/// Real libva, real machine: in the Linux test container there is no render node (and, in
/// the bare image, no libva at all), so the backend must report nothing and not crash.
#[test]
fn without_a_gpu_the_trial_reports_no_backend() {
    if std::path::Path::new("/dev/dri").exists() {
        return; // A machine with a GPU runs the hardware checks instead.
    }
    assert!(run_trial(&|| false).is_empty());
    assert!(matches!(Device::open(), Err(OpenError::Absent(_))));
}

#[test]
fn dropping_the_last_resource_terminates_the_display() {
    let (device, shared) = fake::device(Fake::intel());
    let scaler = VaScaler::new(&device).unwrap();
    drop(device);
    assert!(!shared.lock().unwrap().terminated);
    drop(scaler);
    assert!(shared.lock().unwrap().terminated);
}

/// Real libva: every entry point resolves where libva 2.x is installed, and a machine
/// without it gets `Missing` (no backend), never a crash. The container runs this both ways.
#[test]
fn libva_loads_where_installed_and_is_missing_elsewhere() {
    let installed = [
        "/usr/lib/x86_64-linux-gnu",
        "/usr/lib/aarch64-linux-gnu",
        "/usr/lib64",
        "/usr/lib",
    ]
    .iter()
    .any(|d| {
        std::path::Path::new(d).join("libva.so.2").exists()
            && std::path::Path::new(d).join("libva-drm.so.2").exists()
    });
    match super::api::Api::load() {
        Ok(_) => assert!(installed),
        Err(LoadError::Missing(_)) => assert!(!installed),
        Err(LoadError::Symbol(s)) => panic!("libva lacks {s}"),
    }
}
