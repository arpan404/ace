// SPDX-License-Identifier: Apache-2.0
//! The asked line of a notice: who was asked, their state and the devices included.

use super::people::valid_addressee;
use super::{as_map, is_string, optional_string};
use crate::json_io::Json;

pub(super) fn valid_asked_line(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    map.keys().all(|key| {
        ["about", "to", "devices", "share", "shares", "words"].contains(&key.as_str())
    }) && is_string(map.get("about"))
        && map
            .get("to")
            .and_then(|to| to.as_array())
            .is_some_and(|to| {
                to.iter().all(|entry| {
                    let Some(entry) = as_map(entry) else {
                        return false;
                    };
                    entry.keys().all(|key| ["to", "state", "detail"].contains(&key.as_str()))
                        && valid_addressee(entry.get("to").unwrap_or(&Json::Null))
                        && matches!(
                            entry.get("state"),
                            Some(Json::String(state))
                                if [
                                    "sending", "queued", "answering", "waiting", "answered", "stopped",
                                    "failed", "sent"
                                ]
                                .contains(&state.as_str())
                        )
                        && entry.get("detail").is_none_or(|detail| {
                            matches!(detail, Json::Null)
                                | matches!(detail, Json::String(detail) if detail.len_code_points() <= 512)
                        })
                })
            })
        && map
            .get("devices")
            .and_then(|devices| devices.as_array())
            .is_some_and(|devices| devices.iter().all(valid_device_context_item))
        && matches!(
            map.get("share"),
            Some(Json::String(share)) if share == "thread" || share == "message"
        )
        && map
            .get("shares")
            .and_then(|shares| shares.as_array())
            .is_some_and(|shares| {
                shares
                    .iter()
                    .all(|share| matches!(share, Json::String(_)))
            })
        && optional_string(map.get("words"))
}

fn valid_device_context_item(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    // `strictObject`: exactly these keys.
    map.keys().all(|key| {
        ["type", "id", "name", "kind", "machine", "os", "model", "online"].contains(&key.as_str())
    }) && matches!(map.get("type"), Some(Json::String(kind)) if kind == "device")
        && matches!(map.get("id"), Some(Json::String(id)) if !id.is_empty() && id.len_code_points() <= 256)
        && matches!(map.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len_code_points() <= 256)
        && matches!(
            map.get("kind"),
            Some(Json::String(kind))
                if [
                    "laptop", "desktop", "server", "phone", "tablet", "browser", "simulator",
                    "emulator"
                ]
                .contains(&kind.as_str())
        )
        && map.get("machine").and_then(as_map).is_some_and(|machine| {
            machine.keys().all(|key| ["id", "name", "here"].contains(&key.as_str()))
                && matches!(machine.get("id"), Some(Json::String(id)) if !id.is_empty() && id.len_code_points() <= 256)
                && matches!(machine.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len_code_points() <= 256)
                && matches!(machine.get("here"), Some(Json::Bool(_)))
        })
        && map.get("os").is_none_or(|os| {
            matches!(os, Json::Null) | matches!(os, Json::String(os) if os.len_code_points() <= 64)
        })
        && map.get("model").is_none_or(|model| {
            matches!(model, Json::Null) | matches!(model, Json::String(model) if model.len_code_points() <= 256)
        })
        && matches!(map.get("online"), Some(Json::Bool(_)))
}
