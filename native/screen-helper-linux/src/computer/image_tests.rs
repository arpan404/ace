use super::*;

fn node(id: u64, depth: usize, role: &str, frame: Rect, actionable: bool) -> Node {
    Node {
        id,
        depth,
        role: role.into(),
        flags: vec![],
        name: None,
        value: None,
        detail: None,
        placeholder: None,
        actions: vec![],
        frame: Some(frame),
        actionable,
    }
}

fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect { x, y, w, h }
}

#[test]
fn screenshots_fit_the_long_edge_and_pixel_budget_without_enlarging() {
    assert_eq!(fit(800, 600), (800, 600));
    let (w, h) = fit(3840, 2160);
    assert!(w <= 1568 && u64::from(w) * u64::from(h) <= 1_150_000);
    assert!((f64::from(w) / f64::from(h) - 3840.0 / 2160.0).abs() < 0.01);
    assert_eq!(fit(4000, 100).0, 1568);
}

#[test]
fn downscaling_averages_the_pixels_it_covers() {
    let image = Rgb {
        width: 2,
        height: 2,
        pixels: vec![0, 0, 0, 255, 255, 255, 0, 0, 0, 255, 255, 255],
    };
    let small = downscale(&image, 1, 1);
    assert_eq!(small.pixels, vec![127, 127, 127]);
}

#[test]
fn marks_tag_visible_actionable_elements_scaled_to_the_image() {
    let nodes = [
        node(1, 0, "window", rect(0.0, 0.0, 400.0, 300.0), false),
        node(2, 1, "button", rect(10.0, 10.0, 40.0, 20.0), true),
        node(3, 1, "text", rect(60.0, 10.0, 40.0, 20.0), false),
        node(4, 1, "scroll area", rect(0.0, 100.0, 400.0, 100.0), false),
        node(5, 2, "row", rect(0.0, 250.0, 100.0, 20.0), true),
        node(6, 2, "row", rect(0.0, 150.0, 100.0, 20.0), true),
        node(7, 1, "button", rect(0.0, 0.0, 400.0, 300.0), true),
    ];
    let marks = marks(&nodes, (400.0, 300.0), 0.5);
    assert_eq!(marks.iter().map(|m| m.id).collect::<Vec<_>>(), vec![2, 6]);
    assert_eq!(marks[0].rect, rect(5.0, 5.0, 20.0, 10.0));
}

#[test]
fn drawing_a_mark_outlines_it_and_stays_inside_the_image() {
    let mut image = Rgb {
        width: 20,
        height: 20,
        pixels: vec![0; 20 * 20 * 3],
    };
    draw_marks(
        &mut image,
        &[Mark {
            id: 12,
            rect: rect(15.0, 15.0, 10.0, 10.0),
        }],
    );
    let at = |x: usize, y: usize| &image.pixels[(y * 20 + x) * 3..(y * 20 + x) * 3 + 3];
    assert_eq!(at(15, 19), &ACCENT);
    assert_eq!(at(0, 0), &[0, 0, 0]);
}

#[test]
fn base64_matches_the_standard_alphabet_and_padding() {
    assert_eq!(base64(b""), "");
    assert_eq!(base64(b"f"), "Zg==");
    assert_eq!(base64(b"fo"), "Zm8=");
    assert_eq!(base64(b"foobar"), "Zm9vYmFy");
}
