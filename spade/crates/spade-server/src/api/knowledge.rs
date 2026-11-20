//! Knowledge bases and episodes over HTTP (ADR 0164, docs/knowledge.md): each bot's base under
//! `/agents/{id}/knowledge`, any entry by id under `/knowledge/{entry}`, and episodes.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use super::body::{Body, present};
use super::{AppState, problem};
use crate::engine::{KnowledgeError, KnowledgeInput, entry_json, episode_json};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/agents/{id}/knowledge", get(list).post(add))
        .route("/agents/{id}/knowledge/topics", get(topics))
        .route("/agents/{id}/knowledge/suggestions", get(suggestions))
        .route("/agents/{id}/knowledge/limit", put(limit))
        .route("/knowledge/{entry}", get(read).patch(change).delete(forget))
        .route("/knowledge/{entry}/links", post(link))
        .route("/knowledge/{entry}/links/{to}", delete(unlink))
        .route("/knowledge/{entry}/merge", post(merge))
        .route("/knowledge/{entry}/provenance", get(entry_provenance))
        .route("/agents/{id}/episodes", get(episodes))
        .route("/episodes/{episode}", get(episode))
}

#[derive(Deserialize, Default)]
struct Search {
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    topic: Option<String>,
}

#[derive(Deserialize, Default)]
struct EntryBody {
    #[serde(default)]
    topic: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    trusted: Option<bool>,
    /// The `updated_at` of the version an edit started from.
    #[serde(default)]
    updated_at: Option<i64>,
}

impl EntryBody {
    fn input(self) -> KnowledgeInput {
        KnowledgeInput {
            topic: self.topic,
            title: self.title,
            body: self.body,
            kind: self.kind,
            trusted: self.trusted,
        }
    }
}

#[derive(Deserialize)]
struct LinkBody {
    to: String,
    #[serde(default)]
    relation: Option<String>,
}

#[derive(Deserialize)]
struct MergeBody {
    from: Vec<String>,
}

#[derive(Deserialize)]
struct LimitBody {
    #[serde(default, deserialize_with = "present")]
    bytes: Option<Option<u64>>,
}

fn knowledge_problem(error: &KnowledgeError) -> Response {
    let status = match error {
        KnowledgeError::NotFound | KnowledgeError::NoAgent => StatusCode::NOT_FOUND,
        KnowledgeError::Invalid(_) => StatusCode::BAD_REQUEST,
        KnowledgeError::Full | KnowledgeError::Theirs => StatusCode::CONFLICT,
        KnowledgeError::Moved(entry) => {
            let body = json!({ "error": error.to_string(), "entry": entry_json(entry) });
            return (StatusCode::CONFLICT, Json(body)).into_response();
        }
        KnowledgeError::Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    problem(status, &error.to_string())
}

fn answer(result: Result<Value, KnowledgeError>) -> Response {
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => knowledge_problem(&error),
    }
}

async fn list(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(search): Query<Search>,
) -> Response {
    answer(
        state
            .engine
            .knowledge_entries(&id, search.q.as_deref(), search.topic.as_deref())
            .map(
                |entries| json!({ "entries": entries.iter().map(entry_json).collect::<Vec<_>>() }),
            ),
    )
}

async fn add(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<EntryBody>,
) -> Response {
    match state.engine.add_knowledge(&id, &body.input()) {
        Ok((entry, true)) => (StatusCode::CREATED, Json(entry_json(&entry))).into_response(),
        Ok((entry, false)) => Json(entry_json(&entry)).into_response(),
        Err(error) => knowledge_problem(&error),
    }
}

async fn topics(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    answer(state.engine.knowledge_topics(&id))
}

async fn suggestions(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    answer(state.engine.knowledge_suggestions(&id))
}

async fn limit(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<LimitBody>,
) -> Response {
    answer(
        state
            .engine
            .set_knowledge_limit(&id, body.bytes.flatten())
            .map(|bytes| json!({ "limit_bytes": bytes })),
    )
}

async fn read(State(state): State<AppState>, Path(entry): Path<String>) -> Response {
    answer(state.engine.knowledge_view(&entry).map(|(entry, links)| {
        let mut shown = entry_json(&entry);
        shown["links"] = links
            .iter()
            .map(|l| {
                json!({ "entry": l.other, "relation": l.relation.name(),
                        "direction": if l.outgoing { "to" } else { "from" } })
            })
            .collect();
        shown
    }))
}

async fn change(
    State(state): State<AppState>,
    Path(entry): Path<String>,
    Body(body): Body<EntryBody>,
) -> Response {
    let expected = body.updated_at;
    answer(
        state
            .engine
            .edit_knowledge(&entry, &body.input(), expected)
            .map(|e| entry_json(&e)),
    )
}

async fn forget(State(state): State<AppState>, Path(entry): Path<String>) -> Response {
    match state.engine.remove_knowledge(&entry) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => knowledge_problem(&error),
    }
}

async fn link(
    State(state): State<AppState>,
    Path(entry): Path<String>,
    Body(body): Body<LinkBody>,
) -> Response {
    let relation = body.relation.unwrap_or_else(|| "related".to_owned());
    match state.engine.link_knowledge(&entry, &body.to, &relation) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => knowledge_problem(&error),
    }
}

async fn unlink(
    State(state): State<AppState>,
    Path((entry, to)): Path<(String, String)>,
) -> Response {
    match state.engine.unlink_knowledge(&entry, &to) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => knowledge_problem(&error),
    }
}

async fn merge(
    State(state): State<AppState>,
    Path(entry): Path<String>,
    Body(body): Body<MergeBody>,
) -> Response {
    answer(
        state
            .engine
            .merge_knowledge(&entry, &body.from)
            .map(|e| entry_json(&e)),
    )
}

async fn episodes(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(search): Query<Search>,
) -> Response {
    answer(
        state
            .engine
            .agent_episodes(&id, search.q.as_deref())
            .map(|found| json!({ "episodes": found.iter().map(episode_json).collect::<Vec<_>>() })),
    )
}

async fn episode(State(state): State<AppState>, Path(episode): Path<String>) -> Response {
    answer(
        state
            .engine
            .episode_view(&episode)
            .map(|e| episode_json(&e)),
    )
}

/// Where an entry came from: its source, trust and author, the conversation and message it
/// answered, what was in view, and when.
async fn entry_provenance(State(state): State<AppState>, Path(entry): Path<String>) -> Response {
    super::off_thread(move || match state.engine.entry_provenance(&entry) {
        Ok(Some(shown)) => Json(shown).into_response(),
        Ok(None) => problem(StatusCode::NOT_FOUND, "there is no such entry"),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    })
    .await
}
