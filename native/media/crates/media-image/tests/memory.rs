// SPDX-License-Identifier: Apache-2.0
//! A job's reservation (`peak_bytes`, from headers alone) must cover what it really holds at
//! its peak: measured here with a counting allocator, for the biggest pictures callers send.
#![allow(unsafe_code)]
use media_image::{Input, peak_bytes, run};
use media_wire::image::{ImageOp, ImageOutput};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

// SAFETY: every call forwards to the system allocator unchanged; only counters are added.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let live = LIVE.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
        PEAK.fetch_max(live, Ordering::Relaxed);
        // SAFETY: the caller's layout, as given.
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
        // SAFETY: as allocated above.
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if size > layout.size() {
            let live =
                LIVE.fetch_add(size - layout.size(), Ordering::Relaxed) + size - layout.size();
            PEAK.fetch_max(live, Ordering::Relaxed);
        } else {
            LIVE.fetch_sub(layout.size() - size, Ordering::Relaxed);
        }
        // SAFETY: as allocated above.
        unsafe { System.realloc(ptr, layout, size) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// The tests measure one job at a time.
static ONE: Mutex<()> = Mutex::new(());

type Error = Box<dyn std::error::Error>;

/// A `width` × `height` JPEG, with EXIF orientation `orientation` when it isn't 1.
fn jpeg(width: u32, height: u32, orientation: u16) -> Result<Vec<u8>, Error> {
    let op = ImageOp::Compose {
        width,
        height,
        background: [40, 120, 200, 255],
        max_pixels: width * height,
        layers: vec![],
        output: ImageOutput::Jpeg {
            quality: 85,
            background: None,
        },
    };
    let plain = run(&[], &op, &|| false).map_err(|f| f.message)?.bytes;
    if orientation == 1 {
        return Ok(plain);
    }
    let mut tiff = b"II*\0".to_vec();
    tiff.extend(8u32.to_le_bytes());
    tiff.extend(1u16.to_le_bytes());
    tiff.extend([0x12, 0x01, 3, 0, 1, 0, 0, 0]);
    tiff.extend(orientation.to_le_bytes());
    tiff.extend([0, 0, 0, 0, 0, 0]);
    let mut app1 = vec![0xff, 0xe1];
    app1.extend(((2 + 6 + tiff.len()) as u16).to_be_bytes());
    app1.extend(b"Exif\0\0");
    app1.extend(tiff);
    Ok([&plain[..2], &app1[..], &plain[2..]].concat())
}

/// The job's measured peak above what was live before it, and its reservation.
fn measured(bytes: &[u8], op: &ImageOp) -> Result<(usize, u64), Error> {
    let input = [Input::Encoded(bytes)];
    let reserved = peak_bytes(&input, op).map_err(|f| f.message)?;
    let before = LIVE.load(Ordering::Relaxed);
    PEAK.store(before, Ordering::Relaxed);
    // On a fresh thread: no codec state kept from an earlier job counts against this one.
    let job = op.clone();
    let owned = bytes.to_vec();
    let done = std::thread::spawn(move || {
        run(&[Input::Encoded(&owned)], &job, &|| false).map(|d| d.bytes.len())
    })
    .join()
    .map_err(|_| "panicked")?
    .map_err(|f| f.message)?;
    assert!(done > 0);
    Ok((
        PEAK.load(Ordering::Relaxed) - before - bytes.len(),
        reserved,
    ))
}

fn fit(width: u32, height: u32, output: ImageOutput) -> ImageOp {
    ImageOp::Fit {
        max_pixels: 50_000_000,
        width,
        height,
        auto_orient: true,
        vector_scale: None,
        output,
    }
}

#[test]
fn a_rotated_33_megapixel_photo_stays_within_its_reservation() -> Result<(), Error> {
    let _one = ONE.lock();
    // 8K (33 MP): the largest JPEG this crate's encoder writes to make the fixture.
    let photo = jpeg(7680, 4320, 6)?;
    for op in [
        fit(512, 512, ImageOutput::Png),
        fit(
            1568,
            1568,
            ImageOutput::Jpeg {
                quality: 80,
                background: None,
            },
        ),
    ] {
        let (peak, reserved) = measured(&photo, &op)?;
        assert!(
            peak as u64 <= reserved,
            "{op:?}: held {peak} bytes, reserved {reserved}"
        );
    }
    Ok(())
}

#[test]
fn an_upright_photo_on_the_planar_path_and_a_png_stay_within_their_reservations()
-> Result<(), Error> {
    let _one = ONE.lock();
    let photo = jpeg(4000, 3000, 1)?;
    let (peak, reserved) = measured(
        &photo,
        &fit(
            3000,
            3000,
            ImageOutput::Jpeg {
                quality: 80,
                background: None,
            },
        ),
    )?;
    assert!(
        peak as u64 <= reserved,
        "planar: held {peak}, reserved {reserved}"
    );
    let png = run(
        &[Input::Encoded(&photo)],
        &fit(4000, 4000, ImageOutput::Png),
        &|| false,
    )
    .map_err(|f| f.message)?
    .bytes;
    let (peak, reserved) = measured(&png, &fit(800, 800, ImageOutput::Png))?;
    assert!(
        peak as u64 <= reserved,
        "png: held {peak}, reserved {reserved}"
    );
    Ok(())
}

#[test]
fn a_large_jpeg_leaves_no_codec_state_behind_on_its_thread() -> Result<(), Error> {
    let _one = ONE.lock();
    let photo = jpeg(4000, 3000, 1)?;
    let op = fit(
        3000,
        3000,
        ImageOutput::Jpeg {
            quality: 80,
            background: None,
        },
    );
    let left = std::thread::spawn(move || {
        let before = LIVE.load(Ordering::Relaxed);
        let done = run(&[Input::Encoded(&photo)], &op, &|| false).map(|d| d.bytes.len());
        // Still on the image thread: what it keeps for the next job is what's still live.
        let after = LIVE.load(Ordering::Relaxed);
        (done.is_ok(), after.saturating_sub(before))
    })
    .join()
    .map_err(|_| "panicked")?;
    assert!(left.0);
    assert!(
        left.1 < 1024 * 1024,
        "{} bytes kept after a 12 MP job",
        left.1
    );
    Ok(())
}
