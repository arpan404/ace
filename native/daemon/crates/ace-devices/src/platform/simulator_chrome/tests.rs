// SPDX-License-Identifier: Apache-2.0
//! The cases `simulator-chrome-files.test.ts` moved here: the screens a device type lists and
//! the look its chrome describes, read from the same JSON Xcode writes. The PDFs are drawn by
//! this crate, as Apple's are; ace-media is not involved.

use std::collections::HashMap;

use ace_json::Value;

use super::*;
use crate::platform::posture::Posture;
use crate::platform::simulator_body::{PIECES, svg_body};
use crate::platform::simulator_chrome_file::{chrome_file, identity};
use crate::platform::simulator_panels::{profile, shown_panel, simulator_panels};
use crate::platform::test_pdf::{black, black_art};

fn json(text: &str) -> Value {
    ace_json::parse(text).expect("a test's JSON")
}

/// The profile Xcode writes: a screen, a mask, a notch and the chrome it wears.
const PROFILE: &str = r#"{"mainScreenWidth":1170,"mainScreenHeight":2532,"mainScreenScale":3,
  "framebufferMask":"MASK","sensorBarImage":"notch",
  "chromeIdentifier":"com.apple.dt.devicekit.chrome.testphone",
  "supportedFeatures":{"com.apple.hid.keyboard":true},"modelIdentifier":42}"#;

/// The chrome's own file: nine pieces, their stretch sizes, and two buttons ace can read.
const CHROME: &str = r#"{"identifier":"com.apple.dt.devicekit.chrome.testphone",
  "images":{"topLeft":"TL","top":"T","topRight":"TR","right":"R","bottomRight":"BR",
    "bottom":"B","bottomLeft":"BL","left":"L",
    "sizing":{"leftWidth":22,"rightWidth":22,"topHeight":22,"bottomHeight":22}},
  "inputs":[
    {"name":"volume-up","accessibilityTitle":"Volume Up","image":"Vol","anchor":"left",
     "align":"leading","offsets":{"normal":{"x":8,"y":221},"rollover":{"x":3,"y":221}}},
    {"name":"power","image":"Power","anchor":"right","align":"leading",
     "offsets":{"normal":{"x":-8,"y":262}}},
    {"name":"mystery","anchor":"sideways"}]}"#;

/// A Mac's files for one phone, as the reader holds them: a name to the PDF behind it.
struct Files {
    arts: HashMap<String, Vec<u8>>,
}

impl Files {
    fn install() -> Self {
        let mut arts = HashMap::new();
        for name in ["TL", "T", "TR", "R", "BR", "B", "BL", "L", "Vol", "Power"] {
            arts.insert(name.to_string(), black(16.0, 64.0));
        }
        arts.insert("MASK".to_string(), black(1170.0, 2532.0));
        arts.insert("notch".to_string(), black(176.0, 34.0));
        Self { arts }
    }

    fn without(mut self, name: &str) -> Self {
        self.arts.remove(name);
        self
    }

    fn with(mut self, name: &str, width: f64, height: f64) -> Self {
        self.arts.insert(name.to_string(), black(width, height));
        self
    }

    fn look(&self, chrome: &str, posture: Option<Posture>) -> Option<Chrome> {
        let profile = profile(&json(PROFILE))?;
        let panels = simulator_panels(&profile, None);
        let panel = shown_panel(&panels, posture)?;
        let file = chrome_file(&json(chrome))?;
        let read = |_from: ArtFrom, name: &str, prefix: &str| {
            let art = self.arts.get(name)?;
            crate::platform::pdf_svg::pdf_art(art, prefix)
        };
        let frame = frame(panel, &file, &read)?;
        let painted = frame
            .pieces
            .as_deref()
            .map(|pieces| svg_body(frame.body, pieces));
        chrome_from_frame(panel, &file, &frame, painted.as_deref(), &read)
    }
}

#[test]
fn a_simulators_look_is_its_chromes_body_around_its_screen() {
    let chrome = Files::install()
        .look(CHROME, None)
        .expect("the chrome is drawable");

    // 1170 × 2532 pixels at 3× is a 390 × 844 point screen, 22 points inside the body.
    assert_eq!(
        chrome.screen,
        Rect {
            x: 22.0,
            y: 22.0,
            width: 390.0,
            height: 844.0
        }
    );
    assert_eq!([chrome.body.width, chrome.body.height], [434.0, 888.0]);
    assert!(chrome.body.image.starts_with("data:image/svg+xml;base64,"));
    assert!(
        chrome
            .mask
            .as_deref()
            .is_some_and(|mask| mask.starts_with("data:image/svg+xml;base64,"))
    );
    // The notch hangs from the top of the screen, centred.
    let cutout = chrome.cutout.as_ref().expect("a notch");
    assert_eq!(
        cutout.rect,
        Rect {
            x: 129.0,
            y: 22.0,
            width: 176.0,
            height: 34.0
        }
    );
    // Buttons stand out 8 points from the edge they're anchored to.
    let buttons: Vec<(&str, Option<&str>, Rect)> = chrome
        .buttons
        .iter()
        .map(|button| (button.name.as_str(), button.title.as_deref(), button.rect))
        .collect();
    assert_eq!(
        buttons,
        vec![
            (
                "volume-up",
                Some("Volume Up"),
                Rect {
                    x: -8.0,
                    y: 221.0,
                    width: 16.0,
                    height: 64.0
                }
            ),
            (
                "power",
                None,
                Rect {
                    x: 426.0,
                    y: 262.0,
                    width: 16.0,
                    height: 64.0
                }
            ),
        ]
    );
}

#[test]
fn a_composites_drawing_for_this_screen_size_is_the_body() {
    let chrome_text = CHROME.replace(r#""left":"L","#, r#""left":"L","composite":"Whole","#);
    let chrome = Files::install()
        .with("Whole", 432.0, 886.0)
        .look(&chrome_text, None)
        .expect("the composite is the body");
    assert_eq!([chrome.body.width, chrome.body.height], [432.0, 886.0]);
    // 42 points of margin either way, split as the stretch sizes say.
    assert_eq!(chrome.screen.x, 21.0);
    assert_eq!(chrome.screen.y, 21.0);
    assert_eq!(chrome.screen.width, 390.0);
}

#[test]
fn a_composite_drawn_for_another_size_of_the_same_shape_is_used_whole() {
    let chrome_text = CHROME.replace(r#""left":"L","#, r#""left":"L","composite":"Whole","#);
    let chrome = Files::install()
        .with("Whole", 404.0, 823.0)
        .look(&chrome_text, None)
        .expect("the composite stands for the screen");
    assert_eq!([chrome.body.width, chrome.body.height], [404.0, 823.0]);
    assert_eq!([chrome.screen.x, chrome.screen.y], [22.0, 22.0]);
    assert_eq!([chrome.screen.width, chrome.screen.height], [360.0, 779.0]);
    // The notch is drawn to the body's scale, still centred on the screen.
    let notch = chrome.cutout.as_ref().expect("a notch").rect;
    assert!((notch.x * 2.0 + notch.width - (22.0 * 2.0 + 360.0)).abs() < 0.001);
    assert!((notch.width - 176.0 * 360.0 / 390.0).abs() < 0.001);
}

#[test]
fn an_island_iphone_gets_no_notch() {
    let mut files = Files::install();
    files.arts.insert(
        "notch".to_string(),
        crate::platform::test_pdf::tiny_pdf(393.0, 47.0, "q Q", &[]),
    );
    let chrome = files.look(CHROME, None).expect("a look");
    assert!(chrome.cutout.is_none());
    assert!(chrome.mask.is_some());
}

#[test]
fn a_chrome_missing_a_body_piece_has_no_look() {
    assert!(Files::install().without("BL").look(CHROME, None).is_none());
    // A frame that fits this screen size ignores the pieces, as Simulator does.
    let composite = CHROME.replace(r#""left":"L","#, r#""left":"L","composite":"Whole","#);
    assert!(
        Files::install()
            .without("BL")
            .with("Whole", 432.0, 886.0)
            .look(&composite, None)
            .is_some()
    );
}

#[test]
fn a_side_button_drawn_across_the_edge_is_turned_to_lie_along_it() {
    let chrome = Files::install()
        .with("Vol", 64.0, 16.0)
        .look(CHROME, None)
        .expect("a look");
    let volume = chrome
        .buttons
        .iter()
        .find(|button| button.name == "volume-up")
        .expect("the volume button");
    assert_eq!(
        volume.rect,
        Rect {
            x: -8.0,
            y: 221.0,
            width: 16.0,
            height: 64.0
        }
    );
    // Turned back, it lies along the edge as the hardware does.
    let art = black_art(64.0, 16.0, "v");
    let input = chrome_file(&json(CHROME)).expect("a chrome").inputs[0].clone();
    let turned = along_edge(&art, &input);
    assert_eq!([turned.width, turned.height], [16.0, 64.0]);
}

#[test]
fn buttons_are_bounded_in_code_points_as_zod_counts_them() {
    // Sixty-three letters and an emoji are sixty-four code points, sixty-five UTF-16 units.
    let name = format!("{}😀", "a".repeat(63));
    let accepted = CHROME.replace(r#""name":"power","#, &format!(r#""name":"{name}","#));
    let chrome = Files::install().look(&accepted, None).expect("a look");
    assert!(chrome.buttons.iter().any(|button| button.name == name));
    let too_long = format!("{}😀", "a".repeat(64));
    let rejected = CHROME.replace(r#""name":"power","#, &format!(r#""name":"{too_long}","#));
    let chrome = Files::install().look(&rejected, None).expect("a look");
    assert!(chrome.buttons.iter().all(|button| button.name != too_long));
    assert_eq!(chrome.buttons.len(), 1);
    // A title of sixty-four code points is kept; one past it is dropped, the button kept.
    let kept = CHROME.replace("Volume Up", &format!("{}😀", "t".repeat(63)));
    let chrome = Files::install().look(&kept, None).expect("a look");
    assert_eq!(
        chrome.buttons[0].title,
        Some(format!("{}😀", "t".repeat(63)))
    );
    let long_title = CHROME.replace("Volume Up", &format!("{}😀", "t".repeat(64)));
    let chrome = Files::install().look(&long_title, None).expect("a look");
    assert_eq!(chrome.buttons[0].title, None);
}

#[test]
fn a_foldable_wears_its_covers_chrome_while_shut_and_its_inner_screens_once_open() {
    let capabilities = r#"{"capabilities":{"displays":[
      {"displayType":"integrated","width":1398,"height":2034,"scale":3,
       "chromeIdentifier":"com.apple.dt.devicekit.chrome.testphone"},
      {"displayType":"integrated","width":2007,"height":2853,"scale":3,
       "chromeIdentifier":"com.apple.dt.devicekit.chrome.inner",
       "framebufferMaskIdentifier":"INNER"},
      {"displayType":"tvOut","width":720,"height":480,"scale":1}]}}"#;
    let profile = profile(&json(
        r#"{"chromeIdentifier":"com.apple.dt.devicekit.chrome.testphone",
            "framebufferMask":"MASK","sensorBarImage":"notch"}"#,
    ))
    .expect("a profile");
    let panels = simulator_panels(&profile, Some(&json(capabilities)));
    assert_eq!(panels.len(), 2);
    let shut = shown_panel(&panels, Some(Posture::Closed)).expect("a cover");
    assert_eq!([shut.width, shut.height], [466.0, 678.0]);
    assert_eq!(shut.framebuffer_mask.as_deref(), Some("MASK"));
    let half = shown_panel(&panels, Some(Posture::PartiallyOpen)).expect("the inner screen");
    assert_eq!([half.width, half.height], [669.0, 951.0]);
    assert_eq!(
        half.chrome_identifier.as_deref(),
        Some("com.apple.dt.devicekit.chrome.inner")
    );
    assert_eq!(half.framebuffer_mask.as_deref(), Some("INNER"));
    // The cover's island isn't on the inner screen.
    assert_eq!(half.sensor_bar_image, None);
}

#[test]
fn a_device_type_that_sizes_its_screen_nowhere_has_no_look() {
    let capabilities = r#"{"capabilities":{"displays":[{"displayType":"tvOut","width":720,"height":480,"scale":1}]}}"#;
    let profile = profile(&json("{}")).expect("a profile");
    assert!(simulator_panels(&profile, Some(&json(capabilities))).is_empty());
    // More than sixteen displays is not a list ace reads.
    let many: Vec<String> = (0..17)
        .map(|_| r#"{"displayType":"integrated","width":300,"height":600,"scale":3}"#.to_string())
        .collect();
    let seventeen = format!(r#"{{"capabilities":{{"displays":[{}]}}}}"#, many.join(","));
    assert!(simulator_panels(&profile, Some(&json(&seventeen))).is_empty());
}

#[test]
fn a_chromes_identity_must_match_the_one_the_profile_names() {
    assert_eq!(
        identity(&json(CHROME)).as_deref(),
        Some("com.apple.dt.devicekit.chrome.testphone")
    );
    assert_eq!(identity(&json("{}")), None);
    assert_eq!(identity(&json(r#"{"identifier":42}"#)), None);
    assert_eq!(identity(&json("[]")), None);
}

#[test]
fn the_pieces_are_laid_out_around_the_screen_with_their_edges_tucked_under() {
    let art = black_art(16.0, 64.0, "a");
    let body = crate::platform::simulator_body::BodyArt {
        top_left: Some(art.clone()),
        top: Some(black_art(2.0, 64.0, "b")),
        top_right: Some(art.clone()),
        right: Some(art.clone()),
        bottom_right: Some(art.clone()),
        bottom: Some(black_art(2.0, 64.0, "c")),
        bottom_left: Some(art.clone()),
        left: Some(art.clone()),
        middle: Some(black_art(390.0, 844.0, "d")),
    };
    let pieces = body_layout(&body, 434.0, 888.0).expect("a body");
    assert_eq!(pieces.len(), 9);
    // The middle fill comes first, between the edges.
    assert_eq!(pieces[0].rect.x, 16.0);
    assert_eq!(pieces[0].rect.width, 434.0 - 32.0);
    // The top edge reaches one unit under each corner.
    let top = pieces
        .iter()
        .find(|piece| piece.art.width == 2.0 && piece.rect.y == 0.0)
        .expect("the top edge");
    assert_eq!(top.rect.x, 15.0);
    assert_eq!(top.rect.width, 434.0 - 32.0 + 2.0);
    // The bottom right corner sits at the body's corner.
    let corner = pieces
        .iter()
        .find(|piece| piece.rect.x == 434.0 - 16.0 && piece.rect.y == 888.0 - 64.0)
        .expect("the bottom right corner");
    assert_eq!(corner.rect.width, 16.0);
    assert_eq!(PIECES.len(), 8);
}
