use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use spade_core::package::playbooks::Page;

use super::{AppState, problem, share_review_proof as proof};
use crate::teams::share_template::{self, Draft, Schedule};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Review {
    revision: String,
    acknowledged: Vec<String>,
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

fn attempt_key(bot: &str, id: &str) -> String {
    format!("template-attempt:{bot}:{id}")
}

fn share_id_key(id: &str) -> String {
    format!("template-share-id:{id}")
}

fn published_key(id: &str) -> String {
    format!("template-published:{id}")
}

#[derive(Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Binding {
    revision: String,
    hash: String,
    visibility: String,
    publisher: String,
}

#[derive(Serialize, Deserialize)]
struct Attempt {
    binding: Binding,
    draft: Draft,
}

fn attempt(state: &AppState, bot: &str, id: &str) -> Result<Option<Attempt>, String> {
    state
        .engine
        .store()
        .setting(&attempt_key(bot, id))
        .map_err(|e| e.to_string())?
        .map(|data| serde_json::from_str(&data).map_err(|e| e.to_string()))
        .transpose()
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
        Ok(Some(draft)) => {
            if state.engine.share_source_live(&draft.bot) {
                Ok(draft)
            } else {
                Err(Box::new(problem(
                    StatusCode::GONE,
                    "The source bot was deleted. Publication was cancelled.",
                )))
            }
        }
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

pub(super) async fn scan_skill(
    State(state): State<AppState>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    if !stamped(&state, "skill", "skill-privacy", &headers, &bytes) {
        return problem(StatusCode::FORBIDDEN, crate::security::attest::CONFIRM);
    }
    let Ok(texts) = serde_json::from_slice::<Vec<String>>(&bytes) else {
        return problem(StatusCode::BAD_REQUEST, "The skill couldn't be read.");
    };
    let scan = || -> Result<bool, String> {
        let words = share_template::private_words(
            &state.engine,
            None,
            state.connectors.as_deref(),
            &share_template::system_words(),
        )?;
        Ok(spade_core::template_privacy::contains_private_text(
            &json!(texts),
            &words,
        ))
    };
    match scan() {
        Ok(false) => Json(json!({"ok": true})).into_response(),
        Ok(true) => problem(
            StatusCode::UNPROCESSABLE_ENTITY,
            "The skill contains private text.",
        ),
        Err(_) => problem(
            StatusCode::SERVICE_UNAVAILABLE,
            "Spade couldn't check the skill's privacy.",
        ),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SkillAttestation {
    target: proof::Target,
    files: Vec<proof::File>,
    acknowledged: Vec<String>,
}

pub(super) async fn attest_skill(
    State(state): State<AppState>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    if !stamped(&state, "skill", "skill-attest", &headers, &bytes) {
        return problem(StatusCode::FORBIDDEN, crate::security::attest::CONFIRM);
    }
    let Ok(SkillAttestation {
        target,
        mut files,
        mut acknowledged,
    }) = serde_json::from_slice::<SkillAttestation>(&bytes)
    else {
        return problem(StatusCode::BAD_REQUEST, "That isn't a skill review.");
    };
    let mut expected: Vec<_> = files.iter().map(proof::file_digest).collect();
    expected.sort_unstable();
    acknowledged.sort_unstable();
    if target.visibility != "unlisted"
        || expected != acknowledged
        || !proof::matches_hash(&mut files, &target.hash)
    {
        return problem(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Review the exact skill files before publishing.",
        );
    }
    let Ok(words) = share_template::private_words(
        &state.engine,
        None,
        state.connectors.as_deref(),
        &share_template::system_words(),
    ) else {
        return problem(
            StatusCode::SERVICE_UNAVAILABLE,
            "Spade couldn't check the skill's privacy.",
        );
    };
    let text: Vec<_> = files
        .iter()
        .flat_map(|file| [&file.path, &file.text])
        .collect();
    if spade_core::template_privacy::contains_private_text(&json!(text), &words) {
        return problem(
            StatusCode::UNPROCESSABLE_ENTITY,
            "The skill contains private text.",
        );
    }
    let Some(key) = proof::load_key(&state).await else {
        return missing_review_key();
    };
    attestation(&key, "spade-skill", &target, acknowledged)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TemplateAttestation {
    target: proof::Target,
    review: Review,
    recipe: String,
}

pub(super) async fn attest_template(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    if !stamped(&state, &id, "attest", &headers, &bytes) {
        return problem(StatusCode::FORBIDDEN, crate::security::attest::CONFIRM);
    }
    let Ok(TemplateAttestation {
        target,
        review,
        recipe,
    }) = serde_json::from_slice::<TemplateAttestation>(&bytes)
    else {
        return problem(StatusCode::BAD_REQUEST, "That isn't a template review.");
    };
    if target.name != id.replace('_', "-")
        || target.version != "1.0.0"
        || target.visibility != review.visibility
    {
        return problem(
            StatusCode::CONFLICT,
            "The publication differs from the review.",
        );
    }
    let Some(key) = proof::load_key(&state).await else {
        return missing_review_key();
    };
    state.engine.share_template_write(|| {
        let mut draft = match load(&state, &id) {
            Ok(draft) => draft,
            Err(response) => return *response,
        };
        let Ok(Some(saved)) = attempt(&state, &draft.bot, &id) else {
            return problem(
                StatusCode::CONFLICT,
                "The publication attempt is unavailable.",
            );
        };
        if saved.binding.hash != target.hash
            || saved.binding.publisher != target.publisher
            || saved.binding.revision != review.revision
            || saved.binding.visibility != target.visibility
        {
            return problem(
                StatusCode::CONFLICT,
                "The publication differs from the review.",
            );
        }
        let acknowledged = review.acknowledged.clone();
        if let Err(response) = validate_review(&state, &id, &mut draft, review, true) {
            return *response;
        }
        if serde_json::from_str::<Value>(&recipe).ok().as_ref() != Some(&draft.recipe) {
            return problem(
                StatusCode::CONFLICT,
                "The packaged recipe differs from the review.",
            );
        }
        let mut files = vec![proof::File {
            path: "bot.json".to_owned(),
            text: recipe,
            executable: false,
        }];
        for skill in draft.skills {
            files.push(proof::File {
                path: format!("{}/SKILL.md", skill.reference),
                text: skill.text,
                executable: false,
            });
            files.extend(skill.files.into_iter().map(|file| proof::File {
                path: format!("{}/{}", skill.reference, file.path),
                text: file.text,
                executable: file.executable,
            }));
        }
        files.extend(draft.surface_files.into_iter().map(|file| proof::File {
            path: file.path,
            text: file.text,
            executable: file.executable,
        }));
        if !proof::matches_hash(&mut files, &target.hash) {
            return problem(StatusCode::CONFLICT, "The archive differs from the review.");
        }
        attestation(&key, "spade-bot", &target, acknowledged)
    })
}

fn missing_review_key() -> Response {
    problem(
        StatusCode::SERVICE_UNAVAILABLE,
        "This Spade has no Store review signing key.",
    )
}

fn attestation(
    key: &ring::signature::Ed25519KeyPair,
    kind: &str,
    target: &proof::Target,
    acknowledged: Vec<String>,
) -> Response {
    match proof::sign(key, kind, target, acknowledged) {
        Some(proof) => Json(json!({"proof": proof})).into_response(),
        None => problem(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Spade couldn't sign the review.",
        ),
    }
}

pub(super) async fn read(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    state
        .engine
        .share_template_write(|| match load(&state, &id) {
            Ok(draft) => {
                let status = state.engine.store().setting(&published_key(&id));
                let Ok(status) = status else {
                    return problem(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Couldn't read the template's publication.",
                    );
                };
                let revision = revision(&draft);
                let draft = match attempt(&state, &draft.bot, &id) {
                    Ok(Some(pending)) if pending.binding.revision == revision => pending.draft,
                    Ok(_) => draft,
                    Err(_) => {
                        return problem(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "Couldn't read the publication attempt.",
                        );
                    }
                };
                let Ok(share_id) = state.engine.store().setting(&share_id_key(&id)) else {
                    return problem(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't read the share link.");
                };
                Json(json!({"revision": revision, "draft": draft, "visibility": status, "shareId": share_id}))
                    .into_response()
            }
            Err(response) => *response,
        })
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
    if let Err(response) = validate_review(&state, &id, &mut draft, review, true) {
        return *response;
    }
    Json(draft).into_response()
}

pub(super) async fn preview(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    if !stamped(&state, &id, "preview", &headers, &bytes) {
        return problem(StatusCode::FORBIDDEN, crate::security::attest::CONFIRM);
    }
    let Ok(review) = serde_json::from_slice::<Review>(&bytes) else {
        return problem(StatusCode::BAD_REQUEST, "That isn't a template review.");
    };
    let mut draft = match load(&state, &id) {
        Ok(draft) => draft,
        Err(response) => return *response,
    };
    if let Err(response) = validate_review(&state, &id, &mut draft, review, false) {
        return *response;
    }
    Json(json!({"items": review_items(&draft)})).into_response()
}

#[derive(Serialize)]
struct ReviewItem {
    label: String,
    text: String,
    digest: String,
}

fn review_items(draft: &Draft) -> Vec<ReviewItem> {
    fn add(items: &mut Vec<ReviewItem>, path: String, value: &str, kind: &str) {
        let bytes = serde_json::to_vec(&[kind, &path, value]).unwrap_or_default();
        items.push(ReviewItem {
            label: path,
            text: value.to_owned(),
            digest: crate::code::hex(&Sha256::digest(bytes)),
        });
    }
    fn fields(items: &mut Vec<ReviewItem>, path: &str, value: &Value) {
        match value {
            Value::Object(values) if !values.is_empty() => {
                let keys: Vec<_> = values.keys().collect();
                add(
                    items,
                    path.to_owned(),
                    &json!(keys).to_string(),
                    "object keys",
                );
                for (key, value) in values {
                    let key = key.replace('~', "~0").replace('/', "~1");
                    fields(items, &format!("{path}/{key}"), value);
                }
            }
            Value::Array(values) if !values.is_empty() => {
                add(
                    items,
                    path.to_owned(),
                    &format!("{} items", values.len()),
                    "array length",
                );
                for (index, value) in values.iter().enumerate() {
                    fields(items, &format!("{path}/{index}"), value);
                }
            }
            _ => add(items, path.to_owned(), &value.to_string(), "json"),
        }
    }
    let mut items = Vec::new();
    fields(&mut items, "bot.json", &draft.recipe);
    for skill in &draft.skills {
        add(
            &mut items,
            format!("{}/SKILL.md", skill.reference),
            &skill.text,
            "file",
        );
        for file in &skill.files {
            add(
                &mut items,
                format!("{}/{}", skill.reference, file.path),
                &file.text,
                if file.executable {
                    "executable"
                } else {
                    "file"
                },
            );
        }
    }
    for file in &draft.surface_files {
        add(
            &mut items,
            file.path.clone(),
            &file.text,
            if file.executable {
                "executable"
            } else {
                "file"
            },
        );
    }
    items
}

fn validate_review(
    state: &AppState,
    id: &str,
    draft: &mut Draft,
    review: Review,
    require_acknowledgements: bool,
) -> Result<(), Box<Response>> {
    let refused = |status, message| Box::new(problem(status, message));
    if review.revision != revision(draft) {
        return Err(refused(
            StatusCode::CONFLICT,
            "The template changed. Open its details again.",
        ));
    }
    if !matches!(review.visibility.as_str(), "listed" | "unlisted") {
        return Err(refused(
            StatusCode::BAD_REQUEST,
            "Review every item and choose where to share the template.",
        ));
    }
    match state.engine.store().setting(&published_key(id)) {
        Ok(Some(_)) => {
            return Err(refused(
                StatusCode::CONFLICT,
                "This template is already published.",
            ));
        }
        Ok(None) => {}
        Err(_) => {
            return Err(refused(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Couldn't read the publication status.",
            ));
        }
    }
    let mut seen = review.acknowledged.clone();
    apply_review(state, draft, review)
        .map_err(|message| Box::new(problem(StatusCode::UNPROCESSABLE_ENTITY, &message)))?;
    if require_acknowledgements {
        let mut expected: Vec<_> = review_items(draft)
            .into_iter()
            .map(|item| item.digest)
            .collect();
        seen.sort_unstable();
        expected.sort_unstable();
        if seen != expected {
            return Err(refused(
                StatusCode::UNPROCESSABLE_ENTITY,
                "Review every item in the final package.",
            ));
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Begin {
    binding: Binding,
    review: Review,
    draft: Draft,
}

/// Keeps only the candidate that passed the daemon's final scan. Its source and revision are
/// checked again under the lock that marks a bot as deleting.
pub(super) async fn begin(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    if !stamped(&state, &id, "begin", &headers, &bytes) {
        return problem(StatusCode::FORBIDDEN, crate::security::attest::CONFIRM);
    }
    let Ok(Begin {
        binding,
        review,
        draft: scanned,
    }) = serde_json::from_slice::<Begin>(&bytes)
    else {
        return problem(StatusCode::BAD_REQUEST, "That isn't a publication attempt.");
    };
    if binding.revision != review.revision
        || binding.visibility != review.visibility
        || binding.publisher.is_empty()
        || binding.hash.len() != 64
        || !binding.hash.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return problem(
            StatusCode::BAD_REQUEST,
            "The publication binding doesn't match the review.",
        );
    }
    state.engine.share_template_write(|| {
        let mut draft = match load(&state, &id) {
            Ok(draft) => draft,
            Err(response) => return *response,
        };
        if let Err(response) = validate_review(&state, &id, &mut draft, review, true) {
            return *response;
        }
        if draft != scanned {
            return problem(
                StatusCode::CONFLICT,
                "The package changed after its privacy check.",
            );
        }
        match attempt(&state, &draft.bot, &id) {
            Ok(Some(previous)) if previous.binding == binding && previous.draft == draft => {
                return Json(json!({"ok": true})).into_response();
            }
            Ok(Some(_)) => {
                return problem(
                    StatusCode::CONFLICT,
                    "Finish the existing publication attempt or draft a new template.",
                );
            }
            Ok(None) => {}
            Err(_) => {
                return problem(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Couldn't read the publication attempt.",
                );
            }
        }
        let key = attempt_key(&draft.bot, &id);
        let saved = serde_json::to_string(&Attempt { binding, draft }).is_ok_and(|data| {
            data.len() <= 540 * 1024 && state.engine.store().set_setting(&key, Some(&data)).is_ok()
        });
        if saved {
            Json(json!({"ok": true})).into_response()
        } else {
            problem(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Couldn't keep the reviewed publication attempt.",
            )
        }
    })
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
        Some(&draft.bot),
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

pub(super) async fn published(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    if !stamped(&state, &id, "published", &headers, &bytes) {
        return problem(StatusCode::FORBIDDEN, crate::security::attest::CONFIRM);
    }
    let Ok(mut receipt) = serde_json::from_slice::<Value>(&bytes) else {
        return problem(StatusCode::BAD_REQUEST, "That isn't a publication receipt.");
    };
    let share_id = receipt
        .as_object_mut()
        .and_then(|fields| fields.remove("shareId"));
    let share_id = share_id.as_ref().and_then(Value::as_str);
    let Ok(binding) = serde_json::from_value::<Binding>(receipt) else {
        return problem(StatusCode::BAD_REQUEST, "That isn't a publication receipt.");
    };
    state.engine.share_template_write(|| {
        let draft = match load(&state, &id) {
            Ok(draft) => draft,
            Err(response) => return *response,
        };
        let Ok(Some(pending)) = attempt(&state, &draft.bot, &id) else {
            return problem(
                StatusCode::CONFLICT,
                "There's no matching publication attempt.",
            );
        };
        let valid_share = share_id
            .and_then(|id| uuid::Uuid::parse_str(id).ok())
            .is_some_and(|id| {
                id.get_version_num() == 7 && id.get_variant() == uuid::Variant::RFC4122
            });
        if (binding.visibility == "unlisted" && !valid_share)
            || (binding.visibility == "listed" && share_id.is_some())
            || pending.binding != binding
            || revision(&draft) != binding.revision
            || draft.bot != pending.draft.bot
        {
            return problem(
                StatusCode::CONFLICT,
                "The receipt doesn't match the reviewed publication.",
            );
        }
        let Ok(data) = serde_json::to_string(&pending.draft) else {
            return problem(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Couldn't keep the published template.",
            );
        };
        match state.engine.store().set_settings(&[
            (&Draft::key(&id), Some(&data)),
            (&published_key(&id), Some(&binding.visibility)),
            (&share_id_key(&id), share_id),
            (&attempt_key(&draft.bot, &id), None),
        ]) {
            Ok(()) => Json(json!({ "ok": true })).into_response(),
            Err(_) => problem(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Couldn't keep the published template.",
            ),
        }
    })
}
