//! Non-gating encode benchmark, run as a Cargo example.
use std::time::Instant;
fn main() {
    let mut pixels = vec![0u8; 1280 * 720 * 3];
    for (i, b) in pixels.iter_mut().enumerate() {
        *b = ((i * 31 + i / 100) % 256) as u8;
    }
    let mut jpeg = Vec::with_capacity(1024 * 1024);
    let start = Instant::now();
    for _ in 0..100 {
        jpeg.clear();
        jpeg_encoder::Encoder::new(&mut jpeg, 75)
            .encode(&pixels, 1280, 720, jpeg_encoder::ColorType::Rgb)
            .unwrap();
    }
    println!(
        "{{\"encode_us\":{},\"jpeg_bytes\":{},\"iterations\":100,\"pixels\":921600}}",
        start.elapsed().as_micros() / 100,
        jpeg.len()
    );
}
