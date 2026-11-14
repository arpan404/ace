// SPDX-License-Identifier: Apache-2.0
//! The poster (ADR 0149 §6): the current picture fitted to the viewer's viewport, as a JPEG of
//! 10–20 KB, so a picture shows within about a second on 3G before video starts. It takes the
//! still path, then picks the JPEG quality: the highest that stays within 20 KB. A picture too
//! busy for 20 KB even at the lowest quality is made smaller; one too plain to reach 10 KB
//! at the highest is simply smaller than that.
use super::StillBackend;
use crate::engine::stills::{Made, StillInput};
use media_codec::{Size, fit_size};
use std::sync::Arc;

pub const POSTER_MIN_BYTES: usize = 10_000;
pub const POSTER_MAX_BYTES: usize = 20_000;
pub const LOWEST_QUALITY: u8 = 10;
pub const HIGHEST_QUALITY: u8 = 90;
/// Times the picture is made smaller before the poster gives up.
const SHRINKS: u32 = 3;

/// The quality to encode at, given each quality's size: the highest whose JPEG is at most
/// [`POSTER_MAX_BYTES`], stopping early at one of at least [`POSTER_MIN_BYTES`]. `None` when
/// even [`LOWEST_QUALITY`] is too big. Sizes are taken to grow with quality.
pub fn quality(
    mut bytes_at: impl FnMut(u8) -> Result<usize, String>,
) -> Result<Option<u8>, String> {
    let (mut low, mut high) = (LOWEST_QUALITY, HIGHEST_QUALITY);
    let mut best = None;
    while low <= high {
        let mid = low + (high - low) / 2;
        let bytes = bytes_at(mid)?;
        if bytes > POSTER_MAX_BYTES {
            high = mid - 1;
        } else {
            best = Some(mid);
            if bytes >= POSTER_MIN_BYTES {
                break;
            }
            low = mid + 1;
        }
    }
    Ok(best)
}

/// The input again without units, for preparing the same picture at another size: a video
/// source's decoder already holds it.
fn again(input: &StillInput) -> StillInput {
    match input {
        StillInput::Jpeg { data, size } => StillInput::Jpeg {
            data: Arc::clone(data),
            size: *size,
        },
        StillInput::Video { group, size, .. } => StillInput::Video {
            group: *group,
            size: *size,
            units: Vec::new(),
        },
    }
}

fn smaller(size: Size) -> Size {
    let even = |n: u32| (n * 3 / 4) & !1;
    Size {
        width: even(size.width).max(2),
        height: even(size.height).max(2),
    }
}

/// A poster of `input` for a viewer whose viewport is `viewport`.
pub fn poster(
    backend: &mut dyn StillBackend,
    stream: u32,
    input: StillInput,
    viewport: Size,
) -> Result<Made, String> {
    let source = match &input {
        StillInput::Jpeg { size, .. } | StillInput::Video { size, .. } => *size,
    };
    let mut target = fit_size(source, viewport).map_err(|_| "invalid")?;
    let mut next = Some(input);
    let mut retry = None;
    // Copies over every attempt: each smaller try prepares, and may read back, again.
    let (mut readbacks, mut uploads) = (0, 0);
    for _ in 0..=SHRINKS {
        let input = next.take().or_else(|| retry.take()).ok_or("invalid")?;
        retry = Some(again(&input));
        let mut steps = backend.prepare(stream, input, target)?;
        let mut jpeg = Vec::new();
        let mut count = |step: &media_wire::control::SourceStep| {
            readbacks += step.readbacks;
            uploads += step.uploads;
        };
        let chosen = quality(|q| {
            count(&backend.encode_poster(q, &mut jpeg)?);
            Ok(jpeg.len())
        })?;
        if let Some(q) = chosen {
            let mut encode = backend.encode_poster(q, &mut jpeg)?;
            count(&encode);
            encode.readbacks = readbacks;
            encode.uploads = uploads;
            steps.push(encode);
            return Ok(Made {
                jpeg,
                size: target,
                steps,
            });
        }
        target = smaller(target);
    }
    Err("poster-too-large".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sizes that grow with quality, as JPEG's do.
    fn linear(per_step: usize) -> impl FnMut(u8) -> Result<usize, String> {
        move |q| Ok(usize::from(q) * per_step)
    }

    #[test]
    fn the_highest_quality_within_twenty_kilobytes_is_chosen_and_the_search_stops_inside_the_band()
    {
        let mut tried = Vec::new();
        let chosen = quality(|q| {
            tried.push(q);
            linear(400)(q)
        });
        let Ok(Some(q)) = chosen else {
            panic!("no quality")
        };
        let bytes = usize::from(q) * 400;
        assert!((POSTER_MIN_BYTES..=POSTER_MAX_BYTES).contains(&bytes));
        assert!(tried.len() <= 7, "a bounded search: {tried:?}");
    }

    #[test]
    fn a_plain_picture_takes_the_highest_quality_and_a_busy_one_none() {
        assert_eq!(quality(linear(10)), Ok(Some(HIGHEST_QUALITY)));
        assert_eq!(quality(linear(5_000)), Ok(None));
    }

    #[test]
    fn a_failed_encode_ends_the_search() {
        assert_eq!(
            quality(|_| Err("encode-failed".into())),
            Err("encode-failed".into())
        );
    }
}
