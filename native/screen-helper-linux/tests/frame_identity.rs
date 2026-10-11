use ace_screen_helper_linux::frame_identity::FrameIdentity;
#[test]
fn unchanged_pixels_with_new_geometry_or_format_publish_a_fresh_frame() {
    let mut frames = FrameIdentity::default();
    let pixels = vec![42; 32];
    assert!(frames.update(&pixels, 4, 2, 16, 7));
    assert!(!frames.update(&pixels, 4, 2, 16, 7));
    assert!(frames.update(&pixels, 2, 4, 8, 7));
    assert!(!frames.update(&pixels, 2, 4, 8, 7));
    assert!(frames.update(&pixels, 2, 4, 8, 8));
    assert!(frames.update(&[43; 32], 2, 4, 8, 8));
    assert!(frames.update(&[43; 16], 2, 2, 8, 8));
}
#[test]
fn row_padding_changes_do_not_publish_duplicate_pixels() {
    let mut frames = FrameIdentity::default();
    assert!(frames.update(
        &[1, 2, 3, 4, 0, 0, 0, 0, 5, 6, 7, 8, 0, 0, 0, 0],
        1,
        2,
        8,
        7
    ));
    assert!(!frames.update(
        &[1, 2, 3, 4, 9, 9, 9, 9, 5, 6, 7, 8, 9, 9, 9, 9],
        1,
        2,
        8,
        7
    ));
    assert!(!frames.update(&[1, 2, 3, 4, 5, 6, 7, 8], 1, 2, 4, 7));
}
