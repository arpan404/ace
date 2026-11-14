// SPDX-License-Identifier: Apache-2.0
#![allow(unsafe_code)]
use crate::common::*;
use media_codec::*;
use media_vt::{DecodeOutput, VtDecoder, VtEncoder, VtFormat, VtJpeg};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

struct Counting;
static ON: AtomicBool = AtomicBool::new(false);
static CALLS: AtomicUsize = AtomicUsize::new(0);
#[global_allocator]
static ALLOCATOR: Counting = Counting;
fn count() {
    if ON.load(Ordering::Relaxed) {
        CALLS.fetch_add(1, Ordering::Relaxed);
    }
}
// SAFETY: Forwards every call unchanged to System; counting touches only atomics.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count();
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count();
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, p: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        count();
        unsafe { System.realloc(p, layout, size) }
    }
    unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
        unsafe { System.dealloc(p, layout) }
    }
}
fn counted<T>(work: impl FnOnce() -> T) -> (T, usize) {
    CALLS.store(0, Ordering::SeqCst);
    ON.store(true, Ordering::SeqCst);
    let out = work();
    ON.store(false, Ordering::SeqCst);
    (out, CALLS.load(Ordering::SeqCst))
}

type Fallible<T> = Result<T, Box<dyn std::error::Error>>;

pub fn main() -> Fallible<()> {
    const WARM: u64 = 120;
    const MEASURE: u64 = 600;
    let size = Size {
        width: 1920,
        height: 1080,
    };
    let frames = Frames::new(size, 16)?;
    let mut encoder = VtEncoder::new();
    encoder.configure(&EncodeSpec {
        codec: Codec::H264,
        size,
        fps: 60,
        rate: RateControl::Bitrate(8_000_000),
    })?;
    let mut unit = EncodedUnit {
        codec: Codec::H264,
        size,
        format: BitstreamFormat::Avcc,
        data: Vec::new(),
        key: false,
        description: None,
        pts_us: 0,
        duration_us: 0,
    };
    // The producer's pictures exist before the frame loop (ScreenCaptureKit
    // hands them over); building the `PlatformPicture` box is not the encoder's.
    let pictures = (0..WARM + MEASURE)
        .map(|i| frames.picture(i, i * 16_667))
        .collect::<Result<Vec<_>, _>>()?;
    let mut pictures = pictures.into_iter();
    let mut step = |encoder: &mut VtEncoder, unit: &mut EncodedUnit| -> Fallible<()> {
        let picture = pictures.next().ok_or("out of pictures")?;
        encoder.encode(picture, false)?;
        encoder.flush()?;
        while encoder.poll_into(unit)? {}
        Ok(())
    };
    for _ in 0..WARM {
        step(&mut encoder, &mut unit)?;
    }
    let (result, encode_calls) = counted(|| -> Fallible<()> {
        for _ in 0..MEASURE {
            step(&mut encoder, &mut unit)?;
        }
        Ok(())
    });
    result?;

    // Decode: one unit decoded per frame through the Decoder trait.
    let mut units = Vec::new();
    let mut source = VtEncoder::new();
    source.configure(&EncodeSpec {
        codec: Codec::H264,
        size,
        fps: 60,
        rate: RateControl::Bitrate(8_000_000),
    })?;
    for i in 0..WARM + MEASURE {
        source.encode(frames.picture(i, i * 16_667)?, false)?;
        source.flush()?;
        while let Some(unit) = source.poll_result()? {
            units.push(unit);
        }
    }
    let mut decoder = VtDecoder::new(DecodeOutput::default());
    for unit in &units[..WARM as usize] {
        decoder.decode(unit)?;
    }
    let (result, decode_calls) = counted(|| -> Fallible<()> {
        for unit in &units[WARM as usize..] {
            decoder.decode(unit)?;
        }
        Ok(())
    });
    result?;

    // Stills: VT JPEG into a reused output buffer.
    let mut jpeg = VtJpeg::new(VtFormat::Nv12);
    let mut out = Vec::new();
    let still = frames.picture(0, 0)?;
    for _ in 0..20 {
        jpeg.encode_into(&still, 80, &mut out)?;
    }
    let (result, jpeg_calls) = counted(|| -> Fallible<()> {
        for _ in 0..200 {
            jpeg.encode_into(&still, 80, &mut out)?;
        }
        Ok(())
    });
    result?;

    let per = |calls: usize, n: u64| calls as f64 / n as f64;
    // Expected: encode 0; decode exactly the one `Box<dyn PlatformSurface>`
    // per picture that media-codec's `Decoder` trait returns; JPEG 0 per still
    // on either path (the CPU fallback reuses its RGB and output buffers).
    let failures: Vec<&str> = [
        (encode_calls != 0, "encode allocated"),
        (
            decode_calls > MEASURE as usize,
            "decode allocated more than its boxed surface",
        ),
        (jpeg_calls != 0, "the still path allocated"),
    ]
    .into_iter()
    .filter_map(|(failed, why)| failed.then_some(why))
    .collect();
    let pass = failures.is_empty();
    println!(
        "{{\"bench\":\"alloc\",\"backend\":\"vt\",\"machine\":\"{}\",\"os\":\"{}\",\"load\":{:.1},\"encodeFrames\":{MEASURE},\"encodeAllocations\":{encode_calls},\"decodeAllocationsPerFrame\":{:.2},\"decodeExpectedPerFrame\":1,\"jpegHardware\":{},\"jpegAllocationsPerStill\":{:.2},\"pass\":{pass}}}",
        machine(),
        os_build(),
        load_average(),
        per(decode_calls, MEASURE),
        jpeg.last_path().hardware,
        per(jpeg_calls, 200),
    );
    if !pass {
        return Err(failures.join("; ").into());
    }
    Ok(())
}
