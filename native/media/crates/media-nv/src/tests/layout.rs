// SPDX-License-Identifier: Apache-2.0
//! The layouts the driver reads and writes, pinned for NVENC 12.0 on 64-bit Linux, and the
//! developer-only comparison with NVIDIA's headers (`ACE_NV_HEADERS`, ADR 0148 §3). The
//! numbers here are where our declaration puts each member the driver touches; a change to
//! one must be deliberate and checked against the headers.
use crate::dec_abi::*;
use crate::enc_abi::*;
use std::mem::{offset_of, size_of};

/// `(C expression, our value)`: sizes and offsets of NVENC structures.
fn nvenc_layout() -> Vec<(&'static str, usize)> {
    vec![
        ("sizeof(GUID)", size_of::<Guid>()),
        (
            "sizeof(NV_ENCODE_API_FUNCTION_LIST)",
            size_of::<FunctionList>(),
        ),
        (
            "offsetof(NV_ENCODE_API_FUNCTION_LIST, nvEncGetEncodeCaps)",
            offset_of!(FunctionList, get_encode_caps),
        ),
        (
            "offsetof(NV_ENCODE_API_FUNCTION_LIST, nvEncDestroyEncoder)",
            offset_of!(FunctionList, destroy_encoder),
        ),
        (
            "offsetof(NV_ENCODE_API_FUNCTION_LIST, nvEncOpenEncodeSessionEx)",
            offset_of!(FunctionList, open_encode_session_ex),
        ),
        (
            "offsetof(NV_ENCODE_API_FUNCTION_LIST, nvEncReconfigureEncoder)",
            offset_of!(FunctionList, reconfigure_encoder),
        ),
        (
            "offsetof(NV_ENCODE_API_FUNCTION_LIST, nvEncGetLastErrorString)",
            offset_of!(FunctionList, get_last_error_string),
        ),
        (
            "offsetof(NV_ENCODE_API_FUNCTION_LIST, nvEncGetEncodePresetConfigEx)",
            offset_of!(FunctionList, get_encode_preset_config_ex),
        ),
        (
            "sizeof(NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS)",
            size_of::<OpenSessionParams>(),
        ),
        (
            "offsetof(NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS, apiVersion)",
            offset_of!(OpenSessionParams, api_version),
        ),
        ("sizeof(NV_ENC_CAPS_PARAM)", size_of::<CapsParam>()),
        ("sizeof(NV_ENC_RC_PARAMS)", size_of::<RcParams>()),
        (
            "offsetof(NV_ENC_RC_PARAMS, constQP)",
            offset_of!(RcParams, const_qp),
        ),
        (
            "offsetof(NV_ENC_RC_PARAMS, averageBitRate)",
            offset_of!(RcParams, average_bit_rate),
        ),
        (
            "offsetof(NV_ENC_RC_PARAMS, vbvInitialDelay)",
            offset_of!(RcParams, vbv_initial_delay),
        ),
        ("sizeof(NV_ENC_CONFIG)", size_of::<EncConfig>()),
        (
            "offsetof(NV_ENC_CONFIG, gopLength)",
            offset_of!(EncConfig, gop_length),
        ),
        (
            "offsetof(NV_ENC_CONFIG, frameIntervalP)",
            offset_of!(EncConfig, frame_interval_p),
        ),
        (
            "offsetof(NV_ENC_CONFIG, rcParams)",
            offset_of!(EncConfig, rc),
        ),
        (
            "offsetof(NV_ENC_CONFIG, encodeCodecConfig.h264Config.idrPeriod)",
            offset_of!(EncConfig, codec) + 4 * H264_IDR_PERIOD_WORD,
        ),
        (
            "offsetof(NV_ENC_CONFIG, encodeCodecConfig.hevcConfig.idrPeriod)",
            offset_of!(EncConfig, codec) + 4 * HEVC_IDR_PERIOD_WORD,
        ),
        ("sizeof(NV_ENC_PRESET_CONFIG)", size_of::<PresetConfig>()),
        (
            "offsetof(NV_ENC_PRESET_CONFIG, presetCfg)",
            offset_of!(PresetConfig, config),
        ),
        ("sizeof(NV_ENC_INITIALIZE_PARAMS)", size_of::<InitParams>()),
        (
            "offsetof(NV_ENC_INITIALIZE_PARAMS, enablePTD)",
            offset_of!(InitParams, enable_ptd),
        ),
        (
            "offsetof(NV_ENC_INITIALIZE_PARAMS, encodeConfig)",
            offset_of!(InitParams, encode_config),
        ),
        (
            "offsetof(NV_ENC_INITIALIZE_PARAMS, maxEncodeWidth)",
            offset_of!(InitParams, max_encode_width),
        ),
        (
            "offsetof(NV_ENC_INITIALIZE_PARAMS, tuningInfo)",
            offset_of!(InitParams, tuning_info),
        ),
        (
            "offsetof(NV_ENC_RECONFIGURE_PARAMS, reInitEncodeParams)",
            offset_of!(ReconfigureParams, init),
        ),
        ("sizeof(NV_ENC_PIC_PARAMS)", size_of::<PicParams>()),
        (
            "offsetof(NV_ENC_PIC_PARAMS, encodePicFlags)",
            offset_of!(PicParams, flags),
        ),
        (
            "offsetof(NV_ENC_PIC_PARAMS, inputTimeStamp)",
            offset_of!(PicParams, input_timestamp),
        ),
        (
            "offsetof(NV_ENC_PIC_PARAMS, inputBuffer)",
            offset_of!(PicParams, input_buffer),
        ),
        (
            "offsetof(NV_ENC_PIC_PARAMS, outputBitstream)",
            offset_of!(PicParams, output_bitstream),
        ),
        (
            "offsetof(NV_ENC_PIC_PARAMS, bufferFmt)",
            offset_of!(PicParams, buffer_format),
        ),
        (
            "offsetof(NV_ENC_PIC_PARAMS, pictureStruct)",
            offset_of!(PicParams, picture_struct),
        ),
        (
            "offsetof(NV_ENC_PIC_PARAMS, codecPicParams)",
            offset_of!(PicParams, codec_pic),
        ),
        ("sizeof(NV_ENC_LOCK_BITSTREAM)", size_of::<LockBitstream>()),
        (
            "offsetof(NV_ENC_LOCK_BITSTREAM, bitstreamSizeInBytes)",
            offset_of!(LockBitstream, bitstream_size),
        ),
        (
            "offsetof(NV_ENC_LOCK_BITSTREAM, outputTimeStamp)",
            offset_of!(LockBitstream, output_timestamp),
        ),
        (
            "offsetof(NV_ENC_LOCK_BITSTREAM, bitstreamBufferPtr)",
            offset_of!(LockBitstream, bitstream_ptr),
        ),
        (
            "offsetof(NV_ENC_LOCK_BITSTREAM, pictureType)",
            offset_of!(LockBitstream, picture_type),
        ),
        (
            "sizeof(NV_ENC_REGISTER_RESOURCE)",
            size_of::<RegisterResource>(),
        ),
        (
            "offsetof(NV_ENC_REGISTER_RESOURCE, resourceToRegister)",
            offset_of!(RegisterResource, resource),
        ),
        (
            "offsetof(NV_ENC_REGISTER_RESOURCE, registeredResource)",
            offset_of!(RegisterResource, registered),
        ),
        (
            "offsetof(NV_ENC_REGISTER_RESOURCE, bufferUsage)",
            offset_of!(RegisterResource, buffer_usage),
        ),
        (
            "offsetof(NV_ENC_MAP_INPUT_RESOURCE, registeredResource)",
            offset_of!(MapInputResource, registered),
        ),
        (
            "offsetof(NV_ENC_MAP_INPUT_RESOURCE, mappedBufferFmt)",
            offset_of!(MapInputResource, mapped_format),
        ),
        (
            "offsetof(NV_ENC_CREATE_BITSTREAM_BUFFER, bitstreamBuffer)",
            offset_of!(CreateBitstreamBuffer, bitstream_buffer),
        ),
        (
            "offsetof(NV_ENC_CREATE_INPUT_BUFFER, inputBuffer)",
            offset_of!(CreateInputBuffer, input_buffer),
        ),
        (
            "offsetof(NV_ENC_LOCK_INPUT_BUFFER, bufferDataPtr)",
            offset_of!(LockInputBuffer, data),
        ),
        (
            "offsetof(NV_ENC_LOCK_INPUT_BUFFER, pitch)",
            offset_of!(LockInputBuffer, pitch),
        ),
        (
            "sizeof(NV_ENC_INPUT_RESOURCE_OPENGL_TEX)",
            size_of::<GlTexResource>(),
        ),
        ("NV_ENC_CONFIG_VER", CONFIG_VER as usize),
        ("NV_ENC_INITIALIZE_PARAMS_VER", INITIALIZE_VER as usize),
        ("NV_ENC_PRESET_CONFIG_VER", PRESET_CONFIG_VER as usize),
        ("NV_ENC_RECONFIGURE_PARAMS_VER", RECONFIGURE_VER as usize),
        ("NV_ENC_PIC_PARAMS_VER", PIC_PARAMS_VER as usize),
        ("NV_ENC_LOCK_BITSTREAM_VER", LOCK_BITSTREAM_VER as usize),
        ("NV_ENC_REGISTER_RESOURCE_VER", REGISTER_VER as usize),
        ("NV_ENC_MAP_INPUT_RESOURCE_VER", MAP_VER as usize),
        ("NV_ENC_CREATE_INPUT_BUFFER_VER", CREATE_INPUT_VER as usize),
        ("NV_ENC_LOCK_INPUT_BUFFER_VER", LOCK_INPUT_VER as usize),
        (
            "NV_ENC_CREATE_BITSTREAM_BUFFER_VER",
            CREATE_BITSTREAM_VER as usize,
        ),
        ("NV_ENC_CAPS_PARAM_VER", CAPS_PARAM_VER as usize),
        ("NV_ENC_RC_PARAMS_VER", RC_PARAMS_VER as usize),
        (
            "NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER",
            OPEN_SESSION_VER as usize,
        ),
        (
            "NV_ENCODE_API_FUNCTION_LIST_VER",
            FUNCTION_LIST_VER as usize,
        ),
        ("NVENCAPI_VERSION", API_VERSION as usize),
    ]
}

/// `(C expression, our value)`: NVDEC structures.
fn nvdec_layout() -> Vec<(&'static str, usize)> {
    vec![
        ("sizeof(CUVIDDECODECAPS)", size_of::<DecodeCaps>()),
        (
            "offsetof(CUVIDDECODECAPS, bIsSupported)",
            offset_of!(DecodeCaps, is_supported),
        ),
        (
            "offsetof(CUVIDDECODECAPS, nMaxWidth)",
            offset_of!(DecodeCaps, max_width),
        ),
        ("sizeof(CUVIDEOFORMAT)", size_of::<VideoFormat>()),
        (
            "offsetof(CUVIDEOFORMAT, min_num_decode_surfaces)",
            offset_of!(VideoFormat, min_num_decode_surfaces),
        ),
        (
            "offsetof(CUVIDEOFORMAT, coded_width)",
            offset_of!(VideoFormat, coded_width),
        ),
        (
            "offsetof(CUVIDEOFORMAT, display_area)",
            offset_of!(VideoFormat, display_area),
        ),
        (
            "offsetof(CUVIDEOFORMAT, chroma_format)",
            offset_of!(VideoFormat, chroma_format),
        ),
        (
            "sizeof(CUVIDDECODECREATEINFO)",
            size_of::<DecodeCreateInfo>(),
        ),
        (
            "offsetof(CUVIDDECODECREATEINFO, CodecType)",
            offset_of!(DecodeCreateInfo, codec),
        ),
        (
            "offsetof(CUVIDDECODECREATEINFO, display_area)",
            offset_of!(DecodeCreateInfo, display_area),
        ),
        (
            "offsetof(CUVIDDECODECREATEINFO, OutputFormat)",
            offset_of!(DecodeCreateInfo, output_format),
        ),
        (
            "offsetof(CUVIDDECODECREATEINFO, ulTargetWidth)",
            offset_of!(DecodeCreateInfo, target_width),
        ),
        (
            "offsetof(CUVIDDECODECREATEINFO, vidLock)",
            offset_of!(DecodeCreateInfo, vid_lock),
        ),
        (
            "offsetof(CUVIDDECODECREATEINFO, target_rect)",
            offset_of!(DecodeCreateInfo, target_rect),
        ),
        ("sizeof(CUVIDPARSERDISPINFO)", size_of::<DisplayInfo>()),
        (
            "offsetof(CUVIDPARSERDISPINFO, timestamp)",
            offset_of!(DisplayInfo, timestamp),
        ),
        (
            "offsetof(CUVIDPROCPARAMS, output_stream)",
            offset_of!(ProcParams, output_stream),
        ),
        ("sizeof(CUVIDSOURCEDATAPACKET)", size_of::<SourcePacket>()),
        (
            "offsetof(CUVIDSOURCEDATAPACKET, timestamp)",
            offset_of!(SourcePacket, timestamp),
        ),
        ("sizeof(CUVIDPARSERPARAMS)", size_of::<ParserParams>()),
        (
            "offsetof(CUVIDPARSERPARAMS, pUserData)",
            offset_of!(ParserParams, user_data),
        ),
        (
            "offsetof(CUVIDPARSERPARAMS, pfnSequenceCallback)",
            offset_of!(ParserParams, sequence),
        ),
        (
            "offsetof(CUVIDPARSERPARAMS, pfnDisplayPicture)",
            offset_of!(ParserParams, display),
        ),
        (
            "offsetof(CUVIDPARSERPARAMS, pExtVideoInfo)",
            offset_of!(ParserParams, ext_video_info),
        ),
        ("sizeof(CUDA_MEMCPY2D)", size_of::<Memcpy2d>()),
        (
            "offsetof(CUDA_MEMCPY2D, srcDevice)",
            offset_of!(Memcpy2d, src_device),
        ),
        (
            "offsetof(CUDA_MEMCPY2D, dstHost)",
            offset_of!(Memcpy2d, dst_host),
        ),
        (
            "offsetof(CUDA_MEMCPY2D, WidthInBytes)",
            offset_of!(Memcpy2d, width_in_bytes),
        ),
    ]
}

fn value(table: &[(&str, usize)], name: &str) -> usize {
    table
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, v)| *v)
        .unwrap()
}

#[cfg(all(target_os = "linux", target_pointer_width = "64"))]
#[test]
fn nvenc_members_sit_where_the_pinned_version_puts_them() {
    let t = nvenc_layout();
    for (name, expected) in [
        ("sizeof(GUID)", 16),
        ("sizeof(NV_ENCODE_API_FUNCTION_LIST)", 2568),
        (
            "offsetof(NV_ENCODE_API_FUNCTION_LIST, nvEncGetEncodeCaps)",
            64,
        ),
        (
            "offsetof(NV_ENCODE_API_FUNCTION_LIST, nvEncDestroyEncoder)",
            224,
        ),
        (
            "offsetof(NV_ENCODE_API_FUNCTION_LIST, nvEncOpenEncodeSessionEx)",
            240,
        ),
        (
            "offsetof(NV_ENCODE_API_FUNCTION_LIST, nvEncReconfigureEncoder)",
            264,
        ),
        (
            "offsetof(NV_ENCODE_API_FUNCTION_LIST, nvEncGetEncodePresetConfigEx)",
            320,
        ),
        (
            "offsetof(NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS, apiVersion)",
            24,
        ),
        ("sizeof(NV_ENC_CAPS_PARAM)", 256),
        ("sizeof(NV_ENC_RC_PARAMS)", 128),
        ("offsetof(NV_ENC_RC_PARAMS, averageBitRate)", 20),
        ("offsetof(NV_ENC_CONFIG, gopLength)", 20),
        ("offsetof(NV_ENC_CONFIG, rcParams)", 40),
        (
            "offsetof(NV_ENC_CONFIG, encodeCodecConfig.h264Config.idrPeriod)",
            176,
        ),
        (
            "offsetof(NV_ENC_CONFIG, encodeCodecConfig.hevcConfig.idrPeriod)",
            188,
        ),
        ("offsetof(NV_ENC_PRESET_CONFIG, presetCfg)", 8),
        ("offsetof(NV_ENC_INITIALIZE_PARAMS, encodeConfig)", 88),
        ("offsetof(NV_ENC_INITIALIZE_PARAMS, maxEncodeWidth)", 96),
        ("offsetof(NV_ENC_INITIALIZE_PARAMS, tuningInfo)", 136),
        ("offsetof(NV_ENC_RECONFIGURE_PARAMS, reInitEncodeParams)", 8),
        ("offsetof(NV_ENC_PIC_PARAMS, inputTimeStamp)", 24),
        ("offsetof(NV_ENC_PIC_PARAMS, inputBuffer)", 40),
        ("offsetof(NV_ENC_PIC_PARAMS, bufferFmt)", 64),
        ("offsetof(NV_ENC_PIC_PARAMS, codecPicParams)", 80),
        ("offsetof(NV_ENC_LOCK_BITSTREAM, bitstreamSizeInBytes)", 36),
        ("offsetof(NV_ENC_LOCK_BITSTREAM, bitstreamBufferPtr)", 56),
        ("offsetof(NV_ENC_LOCK_BITSTREAM, pictureType)", 64),
        ("offsetof(NV_ENC_REGISTER_RESOURCE, resourceToRegister)", 24),
        ("offsetof(NV_ENC_REGISTER_RESOURCE, registeredResource)", 32),
        ("offsetof(NV_ENC_REGISTER_RESOURCE, bufferUsage)", 44),
        (
            "offsetof(NV_ENC_MAP_INPUT_RESOURCE, registeredResource)",
            16,
        ),
        ("offsetof(NV_ENC_MAP_INPUT_RESOURCE, mappedBufferFmt)", 32),
        (
            "offsetof(NV_ENC_CREATE_BITSTREAM_BUFFER, bitstreamBuffer)",
            16,
        ),
        ("offsetof(NV_ENC_CREATE_INPUT_BUFFER, inputBuffer)", 24),
        ("offsetof(NV_ENC_LOCK_INPUT_BUFFER, pitch)", 24),
        ("sizeof(NV_ENC_INPUT_RESOURCE_OPENGL_TEX)", 8),
    ] {
        assert_eq!(value(&t, name), expected, "{name}");
    }
}

#[cfg(all(target_os = "linux", target_pointer_width = "64"))]
#[test]
fn nvdec_members_sit_where_the_interface_puts_them_on_64_bit_linux() {
    let t = nvdec_layout();
    for (name, expected) in [
        ("sizeof(CUVIDDECODECAPS)", 88),
        ("offsetof(CUVIDDECODECAPS, nMaxWidth)", 28),
        ("sizeof(CUVIDEOFORMAT)", 64),
        ("offsetof(CUVIDEOFORMAT, coded_width)", 16),
        ("offsetof(CUVIDEOFORMAT, chroma_format)", 40),
        ("sizeof(CUVIDDECODECREATEINFO)", 176),
        ("offsetof(CUVIDDECODECREATEINFO, display_area)", 80),
        ("offsetof(CUVIDDECODECREATEINFO, ulTargetWidth)", 96),
        ("offsetof(CUVIDDECODECREATEINFO, vidLock)", 120),
        ("sizeof(CUVIDPARSERDISPINFO)", 24),
        ("offsetof(CUVIDPROCPARAMS, output_stream)", 56),
        ("sizeof(CUVIDSOURCEDATAPACKET)", 32),
        ("sizeof(CUVIDPARSERPARAMS)", 136),
        ("offsetof(CUVIDPARSERPARAMS, pfnSequenceCallback)", 48),
        ("offsetof(CUVIDPARSERPARAMS, pExtVideoInfo)", 128),
        ("sizeof(CUDA_MEMCPY2D)", 128),
        ("offsetof(CUDA_MEMCPY2D, dstHost)", 80),
    ] {
        assert_eq!(value(&t, name), expected, "{name}");
    }
}

#[test]
fn structure_versions_carry_the_pinned_api_version() {
    // 12.0: major 12 in the low byte, the structure's revision in bits 16–23, 7 in bits 28–30,
    // and bit 31 on the structures that carry it.
    assert_eq!(API_VERSION, 12);
    assert_eq!(MAX_SUPPORTED_AT_LEAST, 0xC0);
    assert_eq!(CAPS_PARAM_VER, 0x7001_000C);
    assert_eq!(FUNCTION_LIST_VER, 0x7002_000C);
    assert_eq!(MAP_VER, 0x7004_000C);
    assert_eq!(CONFIG_VER, 0xF008_000C);
    assert_eq!(INITIALIZE_VER, 0xF005_000C);
    assert_eq!(PIC_PARAMS_VER, 0xF006_000C);
    assert_eq!(PRESET_CONFIG_VER, 0xF004_000C);
    assert_eq!(RECONFIGURE_VER, 0xF001_000C);
}

/// Developer-only (ADR 0148 §3): with `ACE_NV_HEADERS` pointing at a Video Codec SDK
/// `Interface` folder the developer has under their own acceptance of its licence, compile a
/// small C program against it and compare every size, offset and version above. Never in CI;
/// nothing of the SDK enters the repository. NVDEC's check also needs `cuda.h`, from
/// `ACE_CUDA_INCLUDE`.
#[test]
fn layouts_match_nvidias_headers_when_a_developer_points_ace_nv_headers_at_them() {
    let Some(headers) = std::env::var_os("ACE_NV_HEADERS") else {
        return;
    };
    compare("nvEncodeAPI.h", &headers, None, &nvenc_layout());
    if let Some(cuda) = std::env::var_os("ACE_CUDA_INCLUDE") {
        compare("nvcuvid.h", &headers, Some(&cuda), &nvdec_layout());
    }
}

fn compare(
    header: &str,
    headers: &std::ffi::OsStr,
    cuda: Option<&std::ffi::OsStr>,
    table: &[(&str, usize)],
) {
    use std::fmt::Write;
    let dir = std::env::temp_dir().join(format!("ace-nv-layout-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut c = format!(
        "#include <stddef.h>\n#include <stdio.h>\n#include \"{header}\"\nint main(void) {{\n"
    );
    for (expr, _) in table {
        writeln!(c, "  printf(\"%llu\\n\", (unsigned long long)({expr}));").unwrap();
    }
    c.push_str("  return 0;\n}\n");
    let source = dir.join("layout.c");
    let binary = dir.join("layout");
    std::fs::write(&source, c).unwrap();
    let mut cc = std::process::Command::new("cc");
    cc.arg("-I").arg(headers);
    if let Some(cuda) = cuda {
        cc.arg("-I").arg(cuda);
    }
    let status = cc.arg(&source).arg("-o").arg(&binary).status().unwrap();
    assert!(status.success(), "compiling against {header} failed");
    let out = std::process::Command::new(&binary).output().unwrap();
    let values: Vec<usize> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.parse().unwrap())
        .collect();
    let wrong: Vec<String> = table
        .iter()
        .zip(values)
        .filter(|((_, ours), theirs)| ours != theirs)
        .map(|((expr, ours), theirs)| format!("{expr}: ours {ours}, headers {theirs}"))
        .collect();
    let _ = std::fs::remove_dir_all(&dir);
    assert!(wrong.is_empty(), "layout differs:\n{}", wrong.join("\n"));
}
