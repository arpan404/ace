use ace_screen_helper_linux::frame_identity::FrameIdentity;

/// The whole of a `width`×`height` buffer.
fn whole(width: u32, height: u32) -> (u32, u32, u32, u32) {
    (0, 0, width, height)
}

#[test]
fn unchanged_pixels_with_new_geometry_or_format_publish_a_fresh_frame() {
    let mut frames = FrameIdentity::default();
    let pixels = vec![42; 32];
    assert!(frames.update(&pixels, 16, 7, whole(4, 2)));
    assert!(!frames.update(&pixels, 16, 7, whole(4, 2)));
    assert!(frames.update(&pixels, 8, 7, whole(2, 4)));
    assert!(!frames.update(&pixels, 8, 7, whole(2, 4)));
    assert!(frames.update(&pixels, 8, 8, whole(2, 4)));
    assert!(frames.update(&[43; 32], 8, 8, whole(2, 4)));
    assert!(frames.update(&[43; 16], 8, 8, whole(2, 2)));
}
#[test]
fn row_padding_changes_do_not_publish_duplicate_pixels() {
    let mut frames = FrameIdentity::default();
    assert!(frames.update(
        &[1, 2, 3, 4, 0, 0, 0, 0, 5, 6, 7, 8, 0, 0, 0, 0],
        8,
        7,
        whole(1, 2)
    ));
    assert!(!frames.update(
        &[1, 2, 3, 4, 9, 9, 9, 9, 5, 6, 7, 8, 9, 9, 9, 9],
        8,
        7,
        whole(1, 2)
    ));
    assert!(!frames.update(&[1, 2, 3, 4, 5, 6, 7, 8], 4, 7, whole(1, 2)));
}
#[test]
fn a_crop_that_moves_over_unchanged_pixels_publishes_the_new_region() {
    let mut frames = FrameIdentity::default();
    // A 4×2 buffer, pixel bytes all different.
    let pixels: Vec<u8> = (0..32).collect();
    assert!(frames.update(&pixels, 16, 7, (0, 0, 2, 2)));
    assert!(!frames.update(&pixels, 16, 7, (0, 0, 2, 2)));
    // The window moved inside the same buffer: another region, though no pixel changed.
    assert!(frames.update(&pixels, 16, 7, (2, 0, 2, 2)));
    // Same size again, back where it was: a change too.
    assert!(frames.update(&pixels, 16, 7, (0, 0, 2, 2)));
}
#[test]
fn a_change_outside_the_crop_publishes_nothing() {
    let mut frames = FrameIdentity::default();
    let mut pixels: Vec<u8> = (0..32).collect();
    assert!(frames.update(&pixels, 16, 7, (0, 0, 2, 2)));
    pixels[12] = 200; // column 3 of row 0: outside the region
    assert!(!frames.update(&pixels, 16, 7, (0, 0, 2, 2)));
    pixels[4] = 200; // column 1 of row 0: inside
    assert!(frames.update(&pixels, 16, 7, (0, 0, 2, 2)));
}
