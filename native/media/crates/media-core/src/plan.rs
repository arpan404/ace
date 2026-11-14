// SPDX-License-Identifier: Apache-2.0
//! Reconfiguration-time encode planning. Allocation occurs only when the plan changes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Picture {
    pub width: u32,
    pub height: u32,
}
#[derive(Debug)]
pub struct Source<'a> {
    pub width: f64,
    pub height: f64,
    pub scale: f64,
    pub codecs: &'a [&'a str],
}
#[derive(Debug)]
pub struct Viewport {
    pub width: f64,
    pub height: f64,
    pub device_pixel_ratio: f64,
    pub native_shown: bool,
}
#[derive(Debug)]
pub struct VideoViewer<'a> {
    pub id: &'a str,
    pub viewport: Viewport,
    pub codecs: &'a [&'a str],
    pub link: f64,
    pub scale: f64,
}
#[derive(Debug, PartialEq, Eq)]
pub struct Encode {
    pub key: String,
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u32,
}
#[derive(Debug)]
pub struct Plan {
    pub encodes: Vec<Encode>,
    pub capture: Picture,
    pub viewers: Vec<(String, String)>,
}
fn even(value: f64) -> u32 {
    (2.0 * (value / 2.0).round()).max(2.0) as u32
}
pub fn viewer_picture(source: &Source<'_>, viewport: &Viewport) -> Picture {
    let shown = (viewport.width / source.width).min(viewport.height / source.height);
    let scale = (shown * viewport.device_pixel_ratio)
        .min(source.scale)
        .min(2560.0 / source.width.max(source.height));
    Picture {
        width: even(source.width * scale),
        height: even(source.height * scale),
    }
}
pub fn bitrate_ceiling(picture: Picture) -> f64 {
    (f64::from(picture.width) * f64::from(picture.height) * 60.0 * 0.06)
        .clamp(500_000.0, 16_000_000.0)
        .round()
}
pub fn encode_settings(codec: &str, picture: Picture, link: f64) -> Encode {
    Encode {
        key: format!("{codec}/{}x{}/60", picture.width, picture.height),
        codec: codec.to_owned(),
        width: picture.width,
        height: picture.height,
        fps: 60,
        bitrate: link.min(bitrate_ceiling(picture)).max(500_000.0).round() as u32,
    }
}
struct Wanted<'a> {
    id: &'a str,
    codec: &'a str,
    link: f64,
    full: Picture,
    picture: Picture,
}
struct Group<'a> {
    codec: &'a str,
    link: f64,
    picture: Picture,
    members: Vec<&'a str>,
}
fn area(p: Picture) -> i64 {
    i64::from(p.width) * i64::from(p.height)
}
pub fn plan_video(source: &Source<'_>, viewers: &[VideoViewer<'_>]) -> Plan {
    let mut wanted: Vec<_> = viewers
        .iter()
        .filter_map(|v| {
            let codec = v
                .codecs
                .iter()
                .copied()
                .find(|c| source.codecs.contains(c))?;
            if v.viewport.native_shown {
                return None;
            }
            let full = viewer_picture(source, &v.viewport);
            Some(Wanted {
                id: v.id,
                codec,
                link: v.link,
                full,
                picture: Picture {
                    width: even(f64::from(full.width) * v.scale),
                    height: even(f64::from(full.height) * v.scale),
                },
            })
        })
        .collect();
    wanted.sort_by(|a, b| {
        area(b.picture)
            .cmp(&area(a.picture))
            .then_with(|| a.id.cmp(b.id))
    });
    let mut groups: Vec<Group<'_>> = Vec::with_capacity(4);
    let mut capture = Picture::default();
    for v in wanted {
        capture.width = capture.width.max(v.full.width);
        capture.height = capture.height.max(v.full.height);
        let fits = groups.iter().position(|g| {
            g.codec == v.codec
                && f64::from(g.picture.width) <= f64::from(v.picture.width) * 1.25
                && f64::from(g.picture.height) <= f64::from(v.picture.height) * 1.25
        });
        let index = if fits.is_some() {
            fits
        } else if groups.len() < 4 {
            groups.push(Group {
                codec: v.codec,
                link: v.link,
                picture: v.picture,
                members: Vec::new(),
            });
            Some(groups.len() - 1)
        } else {
            groups
                .iter()
                .enumerate()
                .filter(|(_, g)| g.codec == v.codec)
                .min_by_key(|(_, g)| (area(g.picture) - area(v.picture)).abs())
                .map(|(i, _)| i)
        };
        if let Some(index) = index {
            groups[index].members.push(v.id);
            groups[index].link = groups[index].link.min(v.link);
        }
    }
    let mut plan = Plan {
        encodes: Vec::with_capacity(4),
        capture,
        viewers: Vec::with_capacity(viewers.len()),
    };
    for group in groups {
        let encode = encode_settings(group.codec, group.picture, group.link);
        for member in group.members {
            plan.viewers.push((member.to_owned(), encode.key.clone()));
        }
        plan.encodes.push(encode);
    }
    plan
}
