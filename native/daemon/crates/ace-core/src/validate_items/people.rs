// SPDX-License-Identifier: Apache-2.0
//! The people an item speaks to or from: Spade faces, addressees and speakers.

use super::{as_map, is_string};
use crate::json_io::Json;
use crate::validate_shapes::valid_provider_kind;

fn valid_spade_face(value: &Json) -> bool {
    match value {
        Json::Object(face) => {
            face.len() <= 24
                && face.keys().all(|key| key.len() <= 32)
                && face.values().all(|value| {
                    matches!(value, Json::String(text) if text.len() <= 256)
                        | matches!(value, Json::Number(_))
                        | matches!(value, Json::Bool(_))
                        | matches!(value, Json::Null)
                })
        }
        _ => false,
    }
}

pub(super) fn valid_addressee(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    match map.get("kind").and_then(|kind| kind.as_str()) {
        Some("bot") => {
            map.keys().all(|key| ["kind", "id", "name", "avatar", "machine"].contains(&key.as_str()))
                && matches!(map.get("id"), Some(Json::String(id)) if !id.is_empty() && id.len() <= 128)
                && matches!(map.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len() <= 120)
                && map.get("avatar").is_none_or(valid_spade_face)
                && map.get("machine").is_none_or(|machine| {
                    matches!(as_map(machine), Some(machine)
                            if machine.keys().all(|key| ["id", "name"].contains(&key.as_str()))
                                && is_string(machine.get("id"))
                                && is_string(machine.get("name")))
                })
        }
        Some("club") => {
            map.keys().all(|key| ["kind", "id", "name", "faces", "machine"].contains(&key.as_str()))
                && matches!(map.get("id"), Some(Json::String(id)) if !id.is_empty() && id.len() <= 128)
                && matches!(map.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len() <= 120)
                && map.get("faces").is_none_or(|faces| {
                    matches!(faces, Json::Array(faces) if faces.len() <= 3 && faces.iter().all(|face| {
                            let Some(face) = as_map(face) else {
                                return false;
                            };
                            face.keys().all(|key| ["id", "avatar"].contains(&key.as_str()))
                                && matches!(face.get("id"), Some(Json::String(id)) if !id.is_empty() && id.len() <= 128)
                                && face.get("avatar").is_none_or(valid_spade_face)
                        }))
                })
                && map.get("machine").is_none_or(|machine| {
                    matches!(as_map(machine), Some(machine)
                            if machine.keys().all(|key| ["id", "name"].contains(&key.as_str()))
                                && is_string(machine.get("id"))
                                && is_string(machine.get("name")))
                })
        }
        Some("agent") => {
            map.keys().all(|key| ["kind", "threadId", "title", "provider"].contains(&key.as_str()))
                && is_string(map.get("threadId"))
                && matches!(map.get("title"), Some(Json::String(title)) if title.len() <= 256)
                && map.get("provider").is_none_or(|provider| {
                    valid_provider_kind(Some(provider))
                })
        }
        _ => false,
    }
}

pub(super) fn valid_speaker(value: &Json) -> bool {
    let Some(map) = as_map(value) else {
        return false;
    };
    map.keys().all(|key| {
        ["kind", "id", "name", "avatar", "club", "machine", "about", "ask"].contains(&key.as_str())
    }) && matches!(map.get("kind"), Some(Json::String(kind)) if kind == "bot")
        && matches!(map.get("id"), Some(Json::String(id)) if !id.is_empty() && id.len() <= 128)
        && matches!(map.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len() <= 120)
        && map.get("avatar").is_none_or(valid_spade_face)
        && map.get("club").is_none_or(|club| {
            matches!(as_map(club), Some(club)
                    if club.keys().all(|key| ["id", "name"].contains(&key.as_str()))
                        && matches!(club.get("id"), Some(Json::String(id)) if !id.is_empty() && id.len() <= 128)
                        && matches!(club.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len() <= 120))
        })
        && map.get("machine").is_none_or(|machine| {
            matches!(as_map(machine), Some(machine)
                    if machine.keys().all(|key| ["id", "name"].contains(&key.as_str()))
                        && is_string(machine.get("id"))
                        && is_string(machine.get("name")))
        })
        && matches!(map.get("about"), Some(Json::String(about)) if !about.is_empty() && about.len() <= 256)
        && map.get("ask").is_none_or(|ask| {
            matches!(ask, Json::String(ask) if ask.len() <= 160)
        })
}
