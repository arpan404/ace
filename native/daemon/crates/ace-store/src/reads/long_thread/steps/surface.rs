// SPDX-License-Identifier: Apache-2.0
//! A step's surface, worked out from the step itself.
//!
//! The site an agent's browser was on resolves to an origin or a native app
//! identity; anything a surface cannot carry loses the part, never the read.
//! Calls parse borrowed, keeping only the fields a surface reads.

use super::super::common::{LongError, invalid};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;

#[derive(Deserialize)]
struct CallRef<'a> {
    #[serde(borrow, default)]
    result: Option<CallResult<'a>>,
    #[serde(borrow, default)]
    detail: Option<CallDetail<'a>>,
    #[serde(borrow, default)]
    title: Option<Cow<'a, str>>,
}

#[derive(Deserialize)]
struct CallResult<'a> {
    #[serde(borrow, default)]
    target: Option<CallTarget<'a>>,
}

#[derive(Deserialize)]
struct CallTarget<'a> {
    #[serde(rename = "bundleId", default, borrow)]
    bundle_id: Option<Cow<'a, str>>,
    #[serde(rename = "displayName", default, borrow)]
    display_name: Option<Cow<'a, str>>,
}

#[derive(Deserialize)]
struct CallDetail<'a> {
    #[serde(borrow, default)]
    kind: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    url: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    tool: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    arguments: Option<Cow<'a, serde_json::value::RawValue>>,
}

#[derive(Deserialize)]
struct CallArgs<'a> {
    #[serde(borrow, default)]
    app: Option<Cow<'a, str>>,
    #[serde(rename = "bundleId", default, borrow)]
    bundle_id: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    url: Option<Cow<'a, str>>,
}

fn args_of<'a>(detail: &'a CallDetail<'a>) -> CallArgs<'a> {
    match detail.arguments.as_deref() {
        None => CallArgs {
            app: None,
            bundle_id: None,
            url: None,
        },
        Some(raw) => serde_json::from_str(raw.get()).unwrap_or(CallArgs {
            app: None,
            bundle_id: None,
            url: None,
        }),
    }
}

fn field<'a>(args: &'a CallArgs<'a>, key: &str) -> Option<Cow<'a, str>> {
    let value = match key {
        "app" => args.app.clone()?,
        "bundleId" => args.bundle_id.clone()?,
        "url" => args.url.clone()?,
        _ => return None,
    };
    if value.is_empty() { None } else { Some(value) }
}

/// A surface as the wire carries it, in the protocol's field order.
#[derive(Serialize, Clone)]
pub struct Surface {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<Icon>,
}

impl Surface {
    fn browser(icon: Option<Icon>) -> Surface {
        Surface {
            kind: "browser".to_owned(),
            icon,
        }
    }

    fn computer(icon: Option<Icon>) -> Surface {
        Surface {
            kind: "computer".to_owned(),
            icon,
        }
    }
}

/// A resolved site or app, in the protocol's field order.
#[derive(Serialize, Clone)]
#[serde(tag = "kind")]
pub enum Icon {
    #[serde(rename = "site")]
    Site { origin: String },
    #[serde(rename = "app")]
    App {
        identity: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
}

pub fn site_origin(url: &str) -> Option<String> {
    let lower = url.to_ascii_lowercase();
    let (protocol, rest) = if lower.starts_with("https://") {
        ("https://", &url[8..])
    } else if lower.starts_with("http://") {
        ("http://", &url[7..])
    } else {
        return None;
    };
    let host_port = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host_port.is_empty() {
        return None;
    }
    let host = host_port.split('@').next_back().unwrap_or("");
    let (host, port) = match host.rsplit_once(':') {
        Some((host, port)) => {
            if port.chars().all(|ch| ch.is_ascii_digit()) && !port.is_empty() && port.len() <= 5 {
                (host, Some(port))
            } else {
                (host_port, None)
            }
        }
        None => (host_port, None),
    };
    let host_lower = host.to_ascii_lowercase();
    if host_lower.is_empty() || host_lower.len() > 253 {
        return None;
    }
    if !host_lower
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '-')
    {
        return None;
    }
    if host_lower.starts_with('.') || host_lower.starts_with('-') {
        return None;
    }
    let mut origin = format!("{protocol}{host_lower}");
    if let Some(port) = port {
        origin.push(':');
        origin.push_str(port);
    }
    if origin.len() > 512 {
        return None;
    }
    Some(origin)
}

fn contains_browser(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut index = 0;
    while let Some(found) = lower[index..].find("browser") {
        let start = index + found;
        let end = start + 7;
        let before = if start == 0 {
            None
        } else {
            Some(bytes[start - 1] as char)
        };
        let after = bytes.get(end).map(|byte| *byte as char);
        let before_ok = before.is_none_or(|ch| !ch.is_ascii_lowercase());
        let after_ok = after.is_none_or(|ch| !ch.is_ascii_lowercase());
        if before_ok && after_ok {
            return true;
        }
        index = start + 1;
    }
    false
}

fn contains_screen(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    for keyword in ["screen", "computer"] {
        let mut index = 0;
        while let Some(found) = lower[index..].find(keyword) {
            let start = index + found;
            let end = start + keyword.len();
            let before = if start == 0 {
                None
            } else {
                Some(lower.as_bytes()[start - 1] as char)
            };
            let after = lower.as_bytes().get(end).map(|byte| *byte as char);
            let before_ok = before.is_none_or(|ch| !ch.is_ascii_lowercase());
            let after_ok = after.is_some_and(|ch| matches!(ch, '_' | '.' | '-'));
            if before_ok && after_ok {
                return true;
            }
            index = start + 1;
        }
    }
    false
}

/// One recorded step's surface, worked out from its stored call body.
pub fn tool_surface(call_text: &str, carried: Option<&str>) -> Result<Option<Surface>, LongError> {
    let call: CallRef<'_> =
        serde_json::from_str(call_text).map_err(|_| invalid("invalid index row"))?;
    if let Some(target) = call
        .result
        .as_ref()
        .and_then(|result| result.target.as_ref())
        && let Some(bundle) = target.bundle_id.as_deref()
        && !bundle.is_empty()
        && bundle.len() <= 1024
    {
        let icon = Icon::App {
            identity: bundle.to_owned(),
            name: target.display_name.as_deref().map(|name| name.to_owned()),
        };
        return Ok(Some(Surface::computer(Some(icon))));
    }
    let Some(detail) = call.detail.as_ref() else {
        return Ok(None);
    };
    let Some(kind) = detail.kind.as_deref() else {
        return Ok(None);
    };
    if kind == "web.fetch" {
        let Some(url) = detail.url.as_deref() else {
            return Ok(None);
        };
        let Some(origin) = site_origin(url) else {
            return Ok(None);
        };
        return Ok(Some(Surface::browser(Some(Icon::Site { origin }))));
    }
    let title: &str = call.title.as_deref().unwrap_or("");
    let name = if kind == "mcp" {
        detail.tool.as_deref()
    } else if kind == "custom" || kind == "browser" {
        Some(title)
    } else {
        None
    };
    let owned_args;
    let arguments = if kind == "mcp" {
        owned_args = args_of(detail);
        Some(&owned_args)
    } else {
        None
    };
    if let Some(name) = name
        && contains_screen(name)
    {
        let empty = CallArgs {
            app: None,
            bundle_id: None,
            url: None,
        };
        let args = arguments.unwrap_or(&empty);
        let app = field(args, "app");
        let bundle = field(args, "bundleId").or_else(|| {
            app.clone().filter(|app| {
                app.len() <= 1024
                    && app.split('.').count() >= 2
                    && app
                        .chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.')
            })
        });
        if let Some(bundle) = bundle
            && bundle.len() <= 1024
            && !bundle.is_empty()
        {
            let icon = Icon::App {
                identity: bundle.into_owned(),
                name: None,
            };
            return Ok(Some(Surface::computer(Some(icon))));
        }
        return Ok(Some(Surface::computer(None)));
    }
    let is_browser = kind == "browser" || name.is_some_and(contains_browser);
    if is_browser {
        let url = arguments.as_ref().and_then(|args| field(args, "url"));
        let origin = url
            .as_deref()
            .and_then(site_origin)
            .or_else(|| carried.map(|origin| origin.to_owned()));
        let icon = origin.map(|origin| Icon::Site { origin });
        return Ok(Some(Surface::browser(icon)));
    }
    Ok(None)
}

/// A step's surface is valid when its icon resolves; a bare kind still shows.
pub fn valid_surface(surface: Surface) -> Option<Surface> {
    match surface.icon {
        None => Some(surface),
        Some(Icon::Site { ref origin }) => {
            if origin.len() <= 512 {
                Some(surface)
            } else {
                Some(Surface {
                    kind: surface.kind,
                    icon: None,
                })
            }
        }
        Some(Icon::App {
            ref identity,
            ref name,
        }) => {
            // The loader keeps the kind when the icon cannot resolve.
            if !identity.is_empty()
                && identity.len() <= 1024
                && name
                    .as_deref()
                    .is_none_or(|name| super::super::common::js_len(name) <= 256)
            {
                Some(surface)
            } else {
                Some(Surface {
                    kind: surface.kind,
                    icon: None,
                })
            }
        }
    }
}
