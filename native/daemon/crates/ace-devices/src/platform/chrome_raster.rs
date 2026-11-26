// SPDX-License-Identifier: Apache-2.0
//! `chrome-raster.ts`: a look's SVG images as PNG, for clients that can't draw SVG (the native
//! apps). Images that aren't SVG (an emulator skin's WebP) stay. How one SVG becomes PNG bytes
//! is ace-media's (ADR 0208) and passed in.

use super::chrome::Chrome;

/// The data URL prefix of a picture that still has to be drawn.
pub const SVG_PREFIX: &str = "data:image/svg+xml;base64,";

/// Every SVG image a look carries, in the order [`chrome_as_png`] asks for them: the body, the
/// mask, the cutout, then each button's picture and pressed picture.
pub fn png_requests(chrome: &Chrome) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    let mut push = |url: &str| {
        if url.starts_with(SVG_PREFIX) && !urls.iter().any(|seen| seen == url) {
            urls.push(url.to_string());
        }
    };
    push(&chrome.body.image);
    if let Some(mask) = &chrome.mask {
        push(mask);
    }
    if let Some(cutout) = &chrome.cutout {
        push(&cutout.image);
    }
    for button in &chrome.buttons {
        push(&button.image);
        if let Some(pressed) = &button.pressed {
            push(pressed);
        }
    }
    urls
}

/// The same look with every SVG image drawn as PNG. None when the body can't be drawn; a mask,
/// notch or button that can't is left out, as when the SDK lacks it.
pub fn chrome_as_png(chrome: &Chrome, rendered: &dyn Fn(&str) -> Option<String>) -> Option<Chrome> {
    let draw = |url: &str| match url.starts_with(SVG_PREFIX) {
        true => rendered(url),
        false => Some(url.to_string()),
    };
    let body = draw(&chrome.body.image)?;
    let mask = chrome.mask.as_deref().and_then(&draw);
    let cutout = chrome.cutout.as_ref().and_then(|cutout| {
        draw(&cutout.image).map(|image| super::chrome::Cutout {
            rect: cutout.rect,
            image,
        })
    });
    let mut buttons: Vec<super::chrome::Button> = Vec::new();
    for button in &chrome.buttons {
        let Some(image) = draw(&button.image) else {
            continue;
        };
        let pressed = button.pressed.as_deref().and_then(&draw);
        buttons.push(super::chrome::Button {
            name: button.name.clone(),
            title: button.title.clone(),
            rect: button.rect,
            image,
            pressed,
            on_top: button.on_top,
        });
    }
    Some(Chrome {
        body: super::chrome::Body {
            width: chrome.body.width,
            height: chrome.body.height,
            image: body,
        },
        screen: chrome.screen,
        mask,
        cutout,
        buttons,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::chrome::{Body, Button, Cutout, Rect};

    fn svg(width: u32, height: u32, fill: &str) -> String {
        use base64::Engine as _;
        let text = format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{width}\" height=\"{height}\" viewBox=\"0 0 {width} {height}\"><rect width=\"{width}\" height=\"{height}\" fill=\"{fill}\"/></svg>"
        );
        format!(
            "{SVG_PREFIX}{}",
            base64::engine::general_purpose::STANDARD.encode(text)
        )
    }

    /// A drawing that answers PNG for every SVG it is given, and none for "not svg".
    fn draw(url: &str) -> Option<String> {
        let bytes = url.strip_prefix(SVG_PREFIX)?;
        use base64::Engine as _;
        let svg = String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(bytes)
                .ok()?,
        )
        .ok()?;
        match svg.contains("not svg") {
            true => None,
            false => Some(format!("data:image/png;base64,{bytes}")),
        }
    }

    fn look() -> Chrome {
        Chrome {
            body: Body {
                width: 100.0,
                height: 200.0,
                image: svg(100, 200, "#ff0000"),
            },
            screen: Rect {
                x: 10.0,
                y: 10.0,
                width: 80.0,
                height: 180.0,
            },
            mask: Some(svg(80, 180, "#000")),
            cutout: None,
            buttons: vec![Button {
                name: "power".to_string(),
                title: None,
                rect: Rect {
                    x: 96.0,
                    y: 40.0,
                    width: 8.0,
                    height: 30.0,
                },
                image: svg(8, 30, "#00ff00"),
                pressed: None,
                on_top: false,
            }],
        }
    }

    #[test]
    fn a_native_apps_look_is_the_same_look_drawn_as_png() {
        let chrome = look();
        assert_eq!(png_requests(&chrome).len(), 3);
        let png = chrome_as_png(&chrome, &draw).expect("the body is drawn");
        assert!(png.body.image.starts_with("data:image/png;base64,"));
        assert!(
            png.mask
                .as_deref()
                .is_some_and(|mask| mask.starts_with("data:image/png;base64,"))
        );
        assert!(png.buttons[0].image.starts_with("data:image/png;base64,"));
        // Where things are doesn't change with the format.
        assert_eq!(png.screen, chrome.screen);
        assert_eq!(png.buttons[0].rect, chrome.buttons[0].rect);
        assert_eq!([png.body.width, png.body.height], [100.0, 200.0]);
    }

    #[test]
    fn an_emulator_skins_webp_is_sent_as_it_is_and_a_button_that_cannot_be_drawn_is_left_out() {
        let chrome = Chrome {
            body: Body {
                width: 1200.0,
                height: 2541.0,
                image: "data:image/webp;base64,UklGRg==".to_string(),
            },
            screen: Rect {
                x: 59.0,
                y: 58.0,
                width: 1080.0,
                height: 2400.0,
            },
            mask: None,
            cutout: None,
            buttons: vec![Button {
                name: "power".to_string(),
                title: None,
                rect: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 8.0,
                    height: 30.0,
                },
                image: {
                    use base64::Engine as _;
                    format!(
                        "{SVG_PREFIX}{}",
                        base64::engine::general_purpose::STANDARD.encode("not svg")
                    )
                },
                pressed: None,
                on_top: false,
            }],
        };
        let png = chrome_as_png(&chrome, &draw).expect("the webp body stays");
        assert_eq!(png.body.image, "data:image/webp;base64,UklGRg==");
        assert!(png.buttons.is_empty());
    }

    #[test]
    fn a_cutout_that_cannot_be_drawn_is_left_out_and_the_look_kept() {
        let mut chrome = look();
        chrome.cutout = Some(Cutout {
            rect: chrome.screen,
            image: svg(80, 20, "not svg"),
        });
        let png = chrome_as_png(&chrome, &draw).expect("the body is drawn");
        assert!(png.cutout.is_none());
    }

    #[test]
    fn a_body_that_cannot_be_drawn_has_no_look() {
        let mut chrome = look();
        chrome.body.image = svg(100, 200, "not svg");
        assert!(chrome_as_png(&chrome, &draw).is_none());
    }
}
