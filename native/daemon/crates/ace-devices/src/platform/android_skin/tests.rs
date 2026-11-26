// SPDX-License-Identifier: Apache-2.0
//! The cases `android-skin-files.test.ts` moved here, on the layout and the alpha ace-media
//! measured. The skin pictures themselves stay ace-media's to draw (ADR 0208); this crate
//! decides the geometry around them.

use crate::platform::android_skin::{
    Opening, SkinImage, android_skin_chrome, corner_radius, opening, parse_skin_layout,
};

/// A skin laid out as the Android SDK ships one: a portrait picture, a mask and the display.
const PIXEL_LAYOUT: &str = "parts {
  device {
    display {
      width 1080
      height 2400
      x 0
      y 0
    }
  }
  portrait {
    background {
      image back.png
    }
    foreground {
      mask mask.png
      cutout hole
    }
  }
}
layouts {
  portrait {
    width 1200
    height 2541
    event EV_SW:0:1
    part1 {
      name portrait
      x 0
      y 0
    }
    part2 {
      name device
      x 59
      y 58
    }
  }
}
";

/// The alpha along a corner's diagonal for a picture whose glass is opaque from the corner until
/// the rounded opening clears at `first_clear`.
fn alpha(first_clear: usize, reach: usize) -> Vec<Option<u8>> {
    (0..=reach)
        .map(|step| Some(if step < first_clear { 255 } else { 0 }))
        .collect()
}

fn image(url: &str, scan: Vec<Option<u8>>) -> SkinImage {
    SkinImage {
        url: url.to_string(),
        scan,
    }
}

fn skin(layout: &str) -> Opening {
    opening(&parse_skin_layout(layout)).expect("the skin has an opening")
}

fn base64_text(url: &str) -> String {
    use base64::Engine as _;
    let encoded = url.split(',').nth(1).unwrap_or("");
    String::from_utf8(
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("a data URL's base64"),
    )
    .expect("the artwork is UTF-8")
}

/// The `rx` a mask or body rectangle is rounded to.
fn radius_of(svg: &str) -> f64 {
    let at = svg.find("rx=\"").expect("a rounded rectangle") + 4;
    let rest = &svg[at..];
    rest[..rest.find('"').expect("a closing quote")]
        .parse()
        .expect("a number")
}

#[test]
fn an_emulator_wears_one_thin_even_bezel_around_its_display() {
    let opening = skin(PIXEL_LAYOUT);
    assert_eq!([opening.width, opening.height], [1080.0, 2400.0]);
    assert_eq!([opening.x, opening.y], [59.0, 58.0]);
    assert_eq!(opening.background, "back.png");
    assert_eq!(opening.mask.as_deref(), Some("mask.png"));
    assert_eq!(opening.reach(), 158);

    // The display keeps its size; the body hugs it with the same bezel on every side, not the
    // skin picture's uneven 59 / 58 / 83 margins.
    let chrome = android_skin_chrome(
        &opening,
        &image("data:image/png;base64,YmFjaw==", alpha(27, opening.reach())),
        Some(&image(
            "data:image/png;base64,bWFzaw==",
            alpha(16, opening.reach()),
        )),
    );
    assert_eq!(
        [chrome.screen.width, chrome.screen.height],
        [1080.0, 2400.0]
    );
    assert_eq!(chrome.screen.x, chrome.screen.y);
    assert_eq!(chrome.body.width, 1080.0 + 2.0 * chrome.screen.x);
    assert_eq!(chrome.body.height, 2400.0 + 2.0 * chrome.screen.y);
    assert!(chrome.screen.x < 40.0, "{}", chrome.screen.x);
    assert!(chrome.body.image.starts_with("data:image/svg+xml;base64,"));

    // The picture is clipped to the corners the skin's mask draws.
    let mask = chrome.mask.as_deref().expect("a mask");
    let rx = radius_of(&base64_text(mask));
    assert!((rx - 54.6).abs() < 0.5, "rx {rx}");

    // The skin's corners and camera hole are still drawn over the whole display.
    let cutout = chrome.cutout.as_ref().expect("a cutout");
    assert_eq!(cutout.rect, chrome.screen);
    assert_eq!(cutout.image, "data:image/png;base64,bWFzaw==");
    assert!(chrome.buttons.is_empty());
}

#[test]
fn a_skin_with_no_mask_takes_its_screens_roundness_from_the_picture() {
    let layout = PIXEL_LAYOUT.replace("      mask mask.png\n", "");
    let opening = skin(&layout);
    assert_eq!(opening.mask, None);
    let chrome = android_skin_chrome(
        &opening,
        &image("data:image/png;base64,YmFjaw==", alpha(27, opening.reach())),
        None,
    );
    let rx = radius_of(&base64_text(chrome.mask.as_deref().expect("a mask")));
    assert!((rx - 92.2).abs() < 0.5, "rx {rx}");
    assert!(chrome.cutout.is_none());
}

#[test]
fn a_skin_whose_portrait_display_is_turned_is_not_drawn() {
    let turned = PIXEL_LAYOUT.replace("y 58\n", "y 58\n      rotation 1\n");
    assert_eq!(opening(&parse_skin_layout(&turned)), None);
}

#[test]
fn a_picture_that_does_not_fill_the_layout_is_not_drawn() {
    let offset = PIXEL_LAYOUT.replace("name portrait\n      x 0", "name portrait\n      x 2");
    assert_eq!(opening(&parse_skin_layout(&offset)), None);
}

#[test]
fn a_tablet_skin_whose_only_layout_is_landscape_is_read_at_its_natural_way_up() {
    let landscape = PIXEL_LAYOUT
        .replace(
            "width 1080\n      height 2400",
            "width 2560\n      height 1600",
        )
        .replace(
            "  portrait {\n    width 1200\n    height 2541",
            "  landscape {\n    width 2798\n    height 1837",
        )
        .replace("x 59\n      y 58", "x 119\n      y 117");
    let opening = skin(&landscape);
    assert_eq!([opening.width, opening.height], [2560.0, 1600.0]);
    let chrome = android_skin_chrome(
        &opening,
        &image("data:image/png;base64,YmFjaw==", alpha(27, opening.reach())),
        None,
    );
    assert!(chrome.body.width > chrome.body.height);
}

#[test]
fn a_layout_that_names_no_display_draws_nothing() {
    let no_display = PIXEL_LAYOUT.replace("      width 1080\n      height 2400", "");
    assert_eq!(opening(&parse_skin_layout(&no_display)), None);
    assert_eq!(opening(&parse_skin_layout("")), None);
    assert_eq!(
        opening(&parse_skin_layout("layouts {\n  portrait {\n")),
        None
    );
}

#[test]
fn a_layout_image_outside_its_folder_names_no_file() {
    let escaping = PIXEL_LAYOUT.replace("image back.png", "image ../back.png");
    assert_eq!(opening(&parse_skin_layout(&escaping)), None);
    let absolute = PIXEL_LAYOUT.replace("image back.png", "image /back.png");
    assert_eq!(opening(&parse_skin_layout(&absolute)), None);
    let wrong_type = PIXEL_LAYOUT.replace("image back.png", "image back.gif");
    assert_eq!(opening(&parse_skin_layout(&wrong_type)), None);
}

#[test]
fn a_corner_whose_pixel_is_outside_the_picture_cannot_be_measured() {
    let opening = skin(PIXEL_LAYOUT);
    assert_eq!(opening.back_corner(), Some((59, 58)));
    let mut fractional = opening.clone();
    fractional.x = 59.5;
    assert_eq!(fractional.back_corner(), None);
    assert_eq!(corner_radius(&[], 540.0), None);
    assert_eq!(corner_radius(&[None, Some(255)], 540.0), None);
    // An opaque corner is square, and `||` treats a radius of zero as no measurement.
    assert_eq!(corner_radius(&alpha(0, 158), 540.0), Some(0.0));
}

#[test]
fn a_layout_that_nests_deeper_than_the_limit_reads_into_its_parent() {
    let mut text = String::new();
    for level in 0..40 {
        text.push_str(&format!("l{level} {{\n"));
    }
    text.push_str("key value\n");
    let tree = parse_skin_layout(&text);
    let mut node = &tree;
    for level in 0..31 {
        node = node
            .child(&format!("l{level}"))
            .expect("each level past the limit is its parent's");
    }
    // Past the thirty-first level the block is not opened, so the value lands there.
    assert_eq!(node.child("l31"), None);
    assert_eq!(node.value("key"), Some("value"));
}

#[test]
fn comments_and_stray_lines_are_skipped() {
    let tree = parse_skin_layout(
        "layouts {\n  portrait { # the upright one\n    width 100 # points\n\n    j\n  }\n}\n}\n",
    );
    let portrait = tree
        .child("layouts")
        .and_then(|node| node.child("portrait"))
        .expect("a portrait layout");
    assert_eq!(portrait.value("width"), Some("100"));
    assert_eq!(portrait.value("j"), None);
}
