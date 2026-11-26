// SPDX-License-Identifier: Apache-2.0
//! `simulator-chrome.ts`: a Simulator's look from Apple's own files for one of its screens: the
//! screen (its size, the screen-shape PDF, the notch PDF, which chrome it wears) and that
//! chrome's description (nine body pieces, their stretch sizes, the buttons and where they
//! sit). Pure: the parsed files and the PDFs they name come in; the wire shape comes out.

use super::chrome::{Body, Button, Chrome, Cutout, Rect, svg_url};
use super::pdf_svg::{SvgArt, svg_document};
use super::simulator_body::{BodyArt, PlacedPiece, body_layout, svg_body};
use super::simulator_chrome_file::{Align, Anchor, ChromeFile, ChromeInput};
use super::simulator_panels::SimulatorPanel;

/// Which bundle a PDF the chrome names lives in: the device type's own resources, or the
/// chrome bundle's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtFrom {
    Profile,
    Chrome,
}

/// Reads a PDF named by the device type (a mask, a notch) or the chrome (from its bundle) and
/// paints it as SVG art. `prefix` keeps clip ids unique within the drawing.
pub type ArtReader<'a> = &'a dyn Fn(ArtFrom, &str, &str) -> Option<SvgArt>;

fn art_url(art: &SvgArt) -> String {
    svg_url(&svg_document(art))
}

/// Where a button sits on a body of `width` × `height`. Its anchor is the edge it stands on and
/// its offset says how far it reaches past that edge and where it runs along it: from the start
/// (leading), from the end (trailing), or from the middle (a home button on the face).
pub fn button_rect(input: &ChromeInput, button: (f64, f64), body: (f64, f64)) -> Rect {
    let (x, y) = input.offsets;
    let along = |start: f64, extent: f64, length: f64| match input.align {
        Align::Trailing => length + start - extent,
        Align::Center => (length - extent) / 2.0 + start,
        Align::Leading => start,
    };
    let rect = |left: f64, top: f64| Rect {
        x: left,
        y: top,
        width: button.0,
        height: button.1,
    };
    match input.anchor {
        Anchor::Left => rect(x - button.0, along(y, button.1, body.1)),
        Anchor::Right => rect(body.0 + x, along(y, button.1, body.1)),
        Anchor::Top => rect(along(x, button.0, body.0), y - button.1),
        Anchor::Bottom => rect(along(x, button.0, body.0), body.1 + y),
    }
}

/// A side button's art lying along the edge it stands on. Some chromes (an iPhone Duo's inner
/// panel) draw their buttons for the body turned a quarter, so a rocker anchored to the left
/// edge comes long side across; turned back, it lies along the edge as the hardware does.
pub fn along_edge(art: &SvgArt, input: &ChromeInput) -> SvgArt {
    if input.on_top == Some(true) {
        return art.clone();
    }
    let upright = matches!(input.anchor, Anchor::Left | Anchor::Right);
    let across = match upright {
        true => art.width > art.height * 1.5,
        false => art.height > art.width * 1.5,
    };
    if !across {
        return art.clone();
    }
    SvgArt {
        width: art.height,
        height: art.width,
        svg: format!(
            "<g transform=\"translate({} 0) rotate(90)\">{}</g>",
            super::jsnum::rounded(art.height, 3),
            art.svg
        ),
    }
}

fn read_art(read: ArtReader<'_>, from: ArtFrom, file: &str, prefix: &str) -> Option<SvgArt> {
    read(from, file, prefix)
}

/// How far a composite may differ from the sliced body's size and still be the drawing made for
/// this screen (Apple's composites can sit a point inside the stretch sizes).
const COMPOSITE_SLACK: f64 = 4.0;

/// How far a composite's screen opening may differ in shape from the screen's, as a share.
const SHAPE_SLACK: f64 = 0.01;

/// A body as the chrome file describes it: the drawing, where the screen's top left corner sits
/// in it, the screen's size in body units when the body was drawn for another size, and whether
/// the caller still has to paint it.
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub body: (f64, f64),
    pub origin: (f64, f64),
    pub screen: Option<(f64, f64)>,
    /// The composite drawing as a data URL, when the chrome ships one for this screen.
    pub composite: Option<String>,
    /// The pieces around the screen, when the body is built from them.
    pub pieces: Option<Vec<PlacedPiece>>,
}

/// The body as the chrome's single composite drawing, seamless, as Simulator shows it: when it
/// was made for a screen this size, the screen sits where the stretch sizes put it, scaled to
/// the composite's own margins. A composite made for a screen of the same shape but another size
/// (an iPhone Duo's inner panel wears one) is used whole, its opening standing for the screen:
/// only proportions matter. Newer chromes ship nothing else worth drawing, their nine pieces
/// being blank placeholders.
fn composite_frame(chrome: &ChromeFile, screen: (f64, f64), read: ArtReader<'_>) -> Option<Frame> {
    let composite = chrome.composite.as_deref()?;
    let art = read_art(read, ArtFrom::Chrome, composite, "w")?;
    let across = chrome.left_width + chrome.right_width;
    let down = chrome.top_height + chrome.bottom_height;
    let spare = (art.width - screen.0, art.height - screen.1);
    let body = (art.width, art.height);
    if spare.0 <= 0.0
        || spare.1 <= 0.0
        || (spare.0 - across).abs() > COMPOSITE_SLACK
        || (spare.1 - down).abs() > COMPOSITE_SLACK
    {
        let opening = (art.width - across, art.height - down);
        if opening.0 <= 0.0 || opening.1 <= 0.0 {
            return None;
        }
        let shape = screen.0 / screen.1;
        if (opening.0 / opening.1 - shape).abs() > shape * SHAPE_SLACK {
            return None;
        }
        return Some(Frame {
            body,
            origin: (chrome.left_width, chrome.top_height),
            screen: Some(opening),
            composite: Some(art_url(&art)),
            pieces: None,
        });
    }
    let origin = (
        match across > 0.0 {
            true => spare.0 * chrome.left_width / across,
            false => spare.0 / 2.0,
        },
        match down > 0.0 {
            true => spare.1 * chrome.top_height / down,
            false => spare.1 / 2.0,
        },
    );
    Some(Frame {
        body,
        origin,
        screen: None,
        composite: Some(art_url(&art)),
        pieces: None,
    })
}

/// The body built from the chrome's nine pieces around the screen.
fn sliced_frame(chrome: &ChromeFile, screen: (f64, f64), read: ArtReader<'_>) -> Option<Frame> {
    let body = (
        screen.0 + chrome.left_width + chrome.right_width,
        screen.1 + chrome.top_height + chrome.bottom_height,
    );
    let mut art = BodyArt::default();
    for (index, piece) in super::simulator_body::PIECES.iter().enumerate() {
        let name = chrome.piece(piece)?;
        let drawn = read_art(read, ArtFrom::Chrome, name, &format!("p{index}"))?;
        match *piece {
            "topLeft" => art.top_left = Some(drawn),
            "top" => art.top = Some(drawn),
            "topRight" => art.top_right = Some(drawn),
            "right" => art.right = Some(drawn),
            "bottomRight" => art.bottom_right = Some(drawn),
            "bottom" => art.bottom = Some(drawn),
            "bottomLeft" => art.bottom_left = Some(drawn),
            "left" => art.left = Some(drawn),
            _ => return None,
        }
    }
    art.middle = chrome
        .middle()
        .and_then(|name| read_art(read, ArtFrom::Chrome, name, "c"));
    let pieces = body_layout(&art, body.0, body.1)?;
    Some(Frame {
        body,
        origin: (chrome.left_width, chrome.top_height),
        screen: None,
        composite: None,
        pieces: Some(pieces),
    })
}

/// A Simulator's look around one of its screens, before its body is painted.
pub fn frame(panel: &SimulatorPanel, chrome: &ChromeFile, read: ArtReader<'_>) -> Option<Frame> {
    let screen = (panel.width, panel.height);
    composite_frame(chrome, screen, read).or_else(|| sliced_frame(chrome, screen, read))
}

/// The look assembled: `painted` is the body's picture when the frame is built from pieces (the
/// caller paints them, PNG in the daemon); a composite frame carries its own.
pub fn chrome_from_frame(
    panel: &SimulatorPanel,
    chrome: &ChromeFile,
    frame: &Frame,
    painted: Option<&str>,
    read: ArtReader<'_>,
) -> Option<Chrome> {
    let screen = (panel.width, panel.height);
    let image = match (&frame.composite, painted) {
        (Some(composite), _) => composite.clone(),
        (None, Some(painted)) => painted.to_string(),
        (None, None) => svg_body(frame.body, frame.pieces.as_deref()?),
    };
    // Body units per point of the screen: 1, unless the body was drawn for a bigger or smaller one.
    let shown = frame.screen.unwrap_or(screen);
    let unit = shown.0 / screen.0;
    let mut buttons: Vec<Button> = Vec::new();
    for input in &chrome.inputs {
        let image = read_art(read, ArtFrom::Chrome, &input.image, "b");
        let Some(image) = image else {
            continue;
        };
        let art = along_edge(&image, input);
        let pressed = input
            .image_down
            .as_deref()
            .and_then(|name| read_art(read, ArtFrom::Chrome, name, "d"))
            .map(|art| art_url(&along_edge(&art, input)));
        let title = input
            .accessibility_title
            .as_deref()
            .filter(|title| !title.is_empty())
            .map(str::to_string);
        buttons.push(Button {
            name: input.name.clone(),
            title,
            rect: button_rect(input, (art.width, art.height), frame.body),
            image: art_url(&art),
            pressed,
            on_top: input.on_top.unwrap_or(false),
        });
    }
    buttons.truncate(8);
    let mask = panel
        .framebuffer_mask
        .as_deref()
        .and_then(|name| read_art(read, ArtFrom::Profile, name, "m"))
        .map(|art| art_url(&art));
    let cutout = panel
        .sensor_bar_image
        .as_deref()
        .and_then(|name| read_art(read, ArtFrom::Profile, name, "s"))
        .map(|art| Cutout {
            rect: Rect {
                x: frame.origin.0 + (shown.0 - art.width * unit) / 2.0,
                y: frame.origin.1,
                width: art.width * unit,
                height: art.height * unit,
            },
            image: art_url(&art),
        });
    Some(Chrome {
        body: Body {
            width: frame.body.0,
            height: frame.body.1,
            image,
        },
        screen: Rect {
            x: frame.origin.0,
            y: frame.origin.1,
            width: shown.0,
            height: shown.1,
        },
        mask,
        cutout,
        buttons,
    })
}

/// A Simulator's look around one of its screens, or none when its chrome can't be drawn (a
/// piece missing or unreadable). The body is painted as SVG; the daemon paints it as PNG.
pub fn simulator_chrome(
    panel: &SimulatorPanel,
    chrome: &ChromeFile,
    read: ArtReader<'_>,
) -> Option<Chrome> {
    let frame = frame(panel, chrome, read)?;
    chrome_from_frame(panel, chrome, &frame, None, read)
}

#[cfg(test)]
mod tests;
