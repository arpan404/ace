//! Oversight over HTTP (ADR 0135, spade/docs/oversight.md): the service's settings, each bot's
//! caps and review switch, and each bot's activity log.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use spade_core::activity::Kind;

use super::body::{Body, present};
use super::{AppState, problem};
use crate::engine::{ActivityQuery, GlobalChange, OversightChange, OversightError};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/oversight", get(view).put(change))
        .route("/agents/{id}/oversight", get(agent_view).put(agent_change))
        .route("/agents/{id}/activity", get(activity))
}

fn oversight_problem(error: &OversightError) -> Response {
    let status = match error {
        OversightError::NotFound => StatusCode::NOT_FOUND,
        OversightError::Invalid(_) => StatusCode::BAD_REQUEST,
        OversightError::Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    problem(status, &error.to_string())
}

fn store_problem(error: &spade_store::StoreError) -> Response {
    problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string())
}

async fn view(State(state): State<AppState>) -> Response {
    match state.engine.oversight_view() {
        Ok(oversight) => Json(json!({ "oversight": oversight })).into_response(),
        Err(error) => store_problem(&error),
    }
}

#[derive(Deserialize)]
struct Change {
    #[serde(default)]
    time_zone: Option<String>,
    #[serde(default)]
    review_default: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    review_model: Option<Option<String>>,
}

async fn change(State(state): State<AppState>, Body(body): Body<Change>) -> Response {
    let change = GlobalChange {
        time_zone: body.time_zone,
        review_default: body.review_default,
        review_model: body.review_model,
    };
    if let Err(error) = state.engine.set_oversight(change) {
        return oversight_problem(&error);
    }
    view(State(state)).await
}

async fn agent_view(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.engine.store_agent(&id) {
        Ok(Some(agent)) => match state.engine.oversight_json(&agent) {
            Ok(shown) => Json(shown).into_response(),
            Err(error) => store_problem(&error),
        },
        Ok(None) => problem(StatusCode::NOT_FOUND, "no such agent"),
        Err(error) => store_problem(&error),
    }
}

#[derive(Deserialize)]
struct AgentChange {
    #[serde(default, deserialize_with = "present")]
    daily_cap_micros: Option<Option<i64>>,
    #[serde(default, deserialize_with = "present")]
    monthly_cap_micros: Option<Option<i64>>,
    #[serde(default, deserialize_with = "present")]
    review: Option<Option<bool>>,
}

/// A cap as stored: whole micros, never negative.
fn cap(raw: Option<Option<i64>>) -> Result<Option<Option<u64>>, Box<Response>> {
    match raw {
        Some(Some(micros)) => u64::try_from(micros)
            .map(|m| Some(Some(m)))
            .map_err(|_| Box::new(problem(StatusCode::BAD_REQUEST, "a cap can't be negative"))),
        Some(None) => Ok(Some(None)),
        None => Ok(None),
    }
}

async fn agent_change(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<AgentChange>,
) -> Response {
    let change = match (cap(body.daily_cap_micros), cap(body.monthly_cap_micros)) {
        (Ok(daily), Ok(monthly)) => OversightChange {
            daily_cap_micros: daily,
            monthly_cap_micros: monthly,
            review: body.review,
        },
        (Err(problem), _) | (_, Err(problem)) => return *problem,
    };
    if let Err(error) = state.engine.set_agent_oversight(&id, change) {
        return oversight_problem(&error);
    }
    agent_view(State(state), Path(id)).await
}

#[derive(Deserialize, Default)]
struct Filters {
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    day: Option<String>,
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    before: Option<i64>,
    #[serde(default)]
    limit: Option<usize>,
}

async fn activity(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(filters): Query<Filters>,
) -> Response {
    let mut kinds = Vec::new();
    for word in filters
        .kind
        .as_deref()
        .unwrap_or("")
        .split(',')
        .filter(|w| !w.trim().is_empty())
    {
        match Kind::parse(word) {
            Some(kind) => kinds.push(kind),
            None => return problem(StatusCode::BAD_REQUEST, &format!("no kind {word}")),
        }
    }
    let query = ActivityQuery {
        kinds,
        day: filters.day.filter(|d| !d.trim().is_empty()),
        words: filters.q.unwrap_or_default(),
        before: filters.before,
        limit: filters.limit.unwrap_or(200),
    };
    // Folding a long history is file work: off the async threads.
    let engine = state.engine.clone();
    let found = tokio::task::spawn_blocking(move || engine.activity_log(&id, &query)).await;
    match found {
        Ok(Ok(page)) => Json(json!({
            "entries": page.entries,
            "more": page.next_before.is_some(),
            "next_before": page.next_before,
        }))
        .into_response(),
        Ok(Err(error)) => oversight_problem(&error),
        Err(_) => problem(
            StatusCode::INTERNAL_SERVER_ERROR,
            "the activity log stopped",
        ),
    }
}
