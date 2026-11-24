use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use spade_core::package::playbooks::Page;

use super::{AppState, problem};
use crate::teams::share_template::{self, Draft, Schedule};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Review {
    revision: String,
    name: String,
    description: String,
    task: String,
    notes: Vec<String>,
    skills: Vec<String>,
    routines: Vec<Schedule>,
    connectors: Vec<String>,
    visibility: String,
    knowledge: Option<Vec<Page>>,
    include_heartbeat: Option<bool>,
    event_routines: Option<Vec<String>>,
    surfaces: Option<Vec<String>>,
    contracts: Option<Vec<String>>,
    plugins: Option<Vec<String>>,
}

fn revision(draft: &Draft) -> String {
    let data = serde_json::to_vec(draft).unwrap_or_default();
    crate::code::hex(&Sha256::digest(data))
}

fn valid_id(id: &str) -> bool {
    id.starts_with("template_")
        && id.len() <= 80
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn load(state: &AppState, id: &str) -> Result<Draft, Box<Response>> {
    if !valid_id(id) {
        return Err(Box::new(problem(
            StatusCode::NOT_FOUND,
            "No such template.",
        )));
    }
    match state.engine.share_template(id) {
        Ok(Some(draft)) => Ok(draft),
        Ok(None) => Err(Box::new(problem(
            StatusCode::NOT_FOUND,
            "No such template.",
        ))),
        Err(_) => Err(Box::new(problem(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Couldn't read the template.",
        ))),
    }
}

fn stamped(state: &AppState, id: &str, operation: &str, headers: &HeaderMap, bytes: &[u8]) -> bool {
    let stamp = headers
        .get(crate::security::attest::HEADER)
        .and_then(|value| value.to_str().ok());
    let value = format!("{operation}:{}", crate::code::hex(&Sha256::digest(bytes)));
    state
        .engine
        .person_says(stamp, &format!("template:{id}"), &value)
}

pub(super) async fn read(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match load(&state, &id) {
        Ok(draft) => {
            let status = state
                .engine
                .store()
                .setting(&format!("template-published:{id}"));
            let Ok(status) = status else {
                return problem(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Couldn't read the template's publication.",
                );
            };
            Json(json!({"revision": revision(&draft), "draft": draft, "visibility": status}))
                .into_response()
        }
        Err(response) => *response,
    }
}

pub(super) async fn authorize(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    if !stamped(&state, &id, "authorize", &headers, &bytes) {
        return problem(StatusCode::FORBIDDEN, crate::security::attest::CONFIRM);
    }
    let Ok(review) = serde_json::from_slice::<Review>(&bytes) else {
        return problem(StatusCode::BAD_REQUEST, "That isn't a template review.");
    };
    let mut draft = match load(&state, &id) {
        Ok(draft) => draft,
        Err(response) => return *response,
    };
    let current = revision(&draft);
    let same_revision = review.revision == current;
    if !matches!(review.visibility.as_str(), "listed" | "unlisted") {
        return problem(
            StatusCode::BAD_REQUEST,
            "Choose where to share the template.",
        );
    }
    let status = state
        .engine
        .store()
        .setting(&format!("template-published:{id}"));
    match status {
        Ok(Some(_)) => return problem(StatusCode::CONFLICT, "This template is already published."),
        Ok(None) => {}
        Err(_) => {
            return problem(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Couldn't read the publication status.",
            );
        }
    }
    if let Err(message) = apply_review(&state, &mut draft, review) {
        return problem(StatusCode::UNPROCESSABLE_ENTITY, &message);
    }
    if current != revision(&draft) {
        if !same_revision {
            return problem(
                StatusCode::CONFLICT,
                "The template changed. Open its details again.",
            );
        }
        // Keep the approved bytes before any network call, so the same review can be retried.
        let saved = serde_json::to_string(&draft).is_ok_and(|data| {
            data.len() <= 512 * 1024
                && state
                    .engine
                    .store()
                    .set_setting(&Draft::key(&id), Some(&data))
                    .is_ok()
        });
        if !saved {
            return problem(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Couldn't keep the reviewed draft.",
            );
        }
    }
    Json(draft).into_response()
}

fn apply_review(state: &AppState, draft: &mut Draft, review: Review) -> Result<(), String> {
    if review.routines.len() > 32
        || review.notes.len() > 50
        || review.skills.len() > 32
        || review.connectors.len() > 32
    {
        return Err("The template has too many items.".to_owned());
    }
    let original_skills = draft.recipe["skills"].as_array().ok_or("No skill list.")?;
    if review
        .skills
        .iter()
        .any(|skill| !original_skills.contains(&json!(skill)))
    {
        return Err("Choose skills from this template.".to_owned());
    }
    draft
        .skills
        .retain(|file| review.skills.contains(&file.reference));
    let mut needs = draft.recipe["needs"]["connectors"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    needs.retain(|need| {
        need["id"]
            .as_str()
            .is_some_and(|id| review.connectors.iter().any(|c| c == id))
    });
    let mut triggers = vec![json!({"kind": "message"})];
    for routine in review.routines {
        let mut trigger = serde_json::to_value(routine).map_err(|e| e.to_string())?;
        trigger["kind"] = json!("schedule");
        triggers.push(trigger);
    }
    if let Some(original) = draft.recipe["triggers"].as_array() {
        triggers.extend(
            original
                .iter()
                .filter(|trigger| {
                    matches!(trigger["kind"].as_str(), Some("event" | "webhook"))
                        && review.event_routines.as_ref().is_none_or(|names| {
                            trigger["name"]
                                .as_str()
                                .is_some_and(|name| names.iter().any(|id| id == name))
                        })
                })
                .cloned(),
        );
    }
    let recipe = &mut draft.recipe;
    recipe["name"] = json!(review.name.trim());
    recipe["blurb"] = json!(review.description.trim());
    recipe["task"] = json!(review.task.trim());
    recipe["notes"] = json!(review.notes);
    recipe["skills"] = json!(review.skills);
    recipe["triggers"] = Value::Array(triggers);
    recipe["needs"]["connectors"] = Value::Array(needs);
    if let Some(knowledge) = review.knowledge {
        recipe["knowledge"] = json!(knowledge);
    }
    if let Some(fields) = recipe.as_object_mut() {
        if review.include_heartbeat == Some(false) {
            fields.remove("heartbeat");
        }
        retain_items(fields.get_mut("surfaces"), review.surfaces.as_deref(), "id");
        retain_items(
            fields.get_mut("contracts"),
            review.contracts.as_deref(),
            "name",
        );
        if let Some(plugins) = review.plugins {
            if let Some(items) = fields.get_mut("plugins").and_then(Value::as_array_mut) {
                items.retain(|item| {
                    item.as_str()
                        .is_some_and(|name| plugins.iter().any(|id| id == name))
                });
            }
            if let Some(commands) = fields
                .get_mut("plugin_commands")
                .and_then(Value::as_object_mut)
            {
                commands.retain(|name, _| plugins.contains(name));
            }
        }
    }
    draft.surface_files.retain(|file| {
        recipe["surfaces"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["file"] == file.path))
    });
    let names = share_template::private_words(
        &state.engine,
        &draft.bot,
        state.connectors.as_deref(),
        &share_template::system_words(),
    )?;
    share_template::check(recipe, &names)?;
    share_template::check_files(draft, &names)?;
    Ok(())
}

fn retain_items(value: Option<&mut Value>, selected: Option<&[String]>, field: &str) {
    if let (Some(items), Some(selected)) = (value.and_then(Value::as_array_mut), selected) {
        items.retain(|item| {
            item[field]
                .as_str()
                .is_some_and(|name| selected.iter().any(|id| id == name))
        });
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    visibility: String,
    draft: Draft,
}

pub(super) async fn published(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    if !stamped(&state, &id, "published", &headers, &bytes) {
        return problem(StatusCode::FORBIDDEN, crate::security::attest::CONFIRM);
    }
    let Ok(receipt) = serde_json::from_slice::<Receipt>(&bytes) else {
        return problem(StatusCode::BAD_REQUEST, "That isn't a publication receipt.");
    };
    if !valid_id(&id) || !matches!(receipt.visibility.as_str(), "listed" | "unlisted") {
        return problem(StatusCode::BAD_REQUEST, "Invalid publication receipt.");
    }
    let Ok(draft) = serde_json::to_string(&receipt.draft) else {
        return problem(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Couldn't keep the published template.",
        );
    };
    match state.engine.store().set_settings(&[
        (&Draft::key(&id), Some(&draft)),
        (
            &format!("template-published:{id}"),
            Some(&receipt.visibility),
        ),
    ]) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(_) => problem(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Couldn't keep the published template.",
        ),
    }
}
