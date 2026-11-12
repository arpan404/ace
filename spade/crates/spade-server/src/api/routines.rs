//! `/v1/agents/{id}/routines`, `/v1/routines/{id}` and `/v1/agents/{id}/heartbeat`
//! (docs/routines.md, ADR 0129). `POST /v1/routines/{id}/run` also takes the routine's own
//! webhook secret instead of Spade's token.

use axum::Extension;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::routine::{QuietHours, Trigger};

use super::body::{Body, present};
use super::{AppState, problem};
use crate::routines::{
    self, By, HeartbeatInput, HeartbeatView, RoutineError, RoutineInput, RoutineView, RunResult,
};

/// The bearer of a request to a routine's run route that was not Spade's token: the webhook's
/// secret, checked by the route itself.
#[derive(Clone)]
pub(super) struct WebhookBearer(pub String);

/// Whether `path` (with or without `/v1`) is a routine's run route.
pub(super) fn is_run_route(path: &str) -> bool {
    let path = path.strip_prefix("/v1").unwrap_or(path);
    let parts: Vec<&str> = path.split('/').collect();
    matches!(parts.as_slice(), ["", "routines", id, "run"] if !id.is_empty())
}

#[derive(Deserialize)]
pub(super) struct RoutineBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    instruction: Option<String>,
    #[serde(default)]
    trigger: Option<Trigger>,
    #[serde(default)]
    time_zone: Option<String>,
    #[serde(default)]
    paused: Option<bool>,
}

impl RoutineBody {
    fn input(self) -> RoutineInput {
        RoutineInput {
            name: self.name,
            instruction: self.instruction,
            trigger: self.trigger,
            time_zone: self.time_zone,
            paused: self.paused,
        }
    }
}

#[derive(Deserialize)]
pub(super) struct Quiet {
    start: String,
    end: String,
}

#[derive(Deserialize)]
pub(super) struct HeartbeatBody {
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    every_minutes: Option<u32>,
    #[serde(default)]
    checklist: Option<String>,
    #[serde(default, deserialize_with = "present")]
    quiet: Option<Option<Quiet>>,
    #[serde(default)]
    time_zone: Option<String>,
}

/// `HH:MM` as a minute of the day.
fn minute(text: &str) -> Option<u32> {
    let (h, m) = text.trim().split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60 && text.trim().len() >= 4).then_some(h * 60 + m)
}

fn clock(minute: u32) -> String {
    format!("{:02}:{:02}", minute / 60, minute % 60)
}

fn failure(error: &RoutineError) -> Response {
    let status = match error {
        RoutineError::NotFound | RoutineError::NoAgent => StatusCode::NOT_FOUND,
        RoutineError::Invalid(_) => StatusCode::BAD_REQUEST,
        RoutineError::Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    problem(status, &error.to_string())
}

fn run_json(run: &RunResult) -> Value {
    json!({ "id": run.id, "at": run.at_ms, "cause": run.cause, "result": run.result,
            "detail": run.detail })
}

fn routine_json(view: &RoutineView) -> Value {
    let r = &view.routine;
    json!({
        "id": r.id,
        "agent": r.agent_id,
        "name": r.name,
        "instruction": r.instruction,
        "trigger": view.trigger,
        "words": view.words,
        "time_zone": r.time_zone,
        "paused": r.paused,
        "next_run": view.next_run_ms,
        "last_run": view.last_run.as_ref().map(run_json),
        "webhook": r.secret.as_ref().map(|secret| json!({
            "path": format!("/v1/routines/{}/run", r.id),
            "secret": secret,
        })),
        "created_by": r.created_by,
        "created_at": r.created_ms,
        "updated_at": r.updated_ms,
    })
}

fn heartbeat_json(view: &HeartbeatView) -> Value {
    json!({
        "enabled": view.enabled,
        "every_minutes": view.every_minutes,
        "checklist": view.checklist,
        "quiet": view.quiet.map(|q| json!({ "start": clock(q.start), "end": clock(q.end) })),
        "time_zone": view.time_zone,
        "next_run": view.next_run_ms,
        "last_run": view.last_run.as_ref().map(run_json),
    })
}

pub(super) async fn list(State(state): State<AppState>, Path(agent): Path<String>) -> Response {
    match routines::list(&state.engine, &agent) {
        Ok(views) => {
            Json(json!({ "routines": views.iter().map(routine_json).collect::<Vec<_>>() }))
                .into_response()
        }
        Err(error) => failure(&error),
    }
}

pub(super) async fn create(
    State(state): State<AppState>,
    Path(agent): Path<String>,
    Body(body): Body<RoutineBody>,
) -> Response {
    match routines::create(&state.engine, &agent, body.input(), By::Person) {
        Ok(view) => (
            StatusCode::CREATED,
            Json(json!({ "routine": routine_json(&view) })),
        )
            .into_response(),
        Err(error) => failure(&error),
    }
}

pub(super) async fn get(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match routines::get(&state.engine, &id) {
        Ok(view) => Json(json!({ "routine": routine_json(&view) })).into_response(),
        Err(error) => failure(&error),
    }
}

pub(super) async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<RoutineBody>,
) -> Response {
    match routines::update(&state.engine, &id, body.input()) {
        Ok(view) => Json(json!({ "routine": routine_json(&view) })).into_response(),
        Err(error) => failure(&error),
    }
}

pub(super) async fn delete(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match routines::delete(&state.engine, &id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => failure(&error),
    }
}

/// Runs the routine now: with Spade's token as the person asked, or with the routine's secret as
/// its webhook.
pub(super) async fn run(
    State(state): State<AppState>,
    Path(id): Path<String>,
    webhook: Option<Extension<WebhookBearer>>,
) -> Response {
    let by_webhook = match webhook {
        None => false,
        Some(Extension(WebhookBearer(given))) => {
            let secret = state
                .engine
                .store()
                .routine(&id)
                .ok()
                .flatten()
                .and_then(|r| r.secret);
            match secret {
                Some(secret) if same(&given, &secret) => true,
                _ => return problem(StatusCode::UNAUTHORIZED, "missing or wrong token"),
            }
        }
    };
    match routines::run_now(&state.engine, &id, by_webhook).await {
        Ok(run) => (StatusCode::ACCEPTED, Json(json!({ "run": run_json(&run) }))).into_response(),
        Err(RoutineError::Invalid(why)) => problem(StatusCode::CONFLICT, &why),
        Err(error) => failure(&error),
    }
}

/// Compares in time independent of where the strings differ.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

pub(super) async fn heartbeat(
    State(state): State<AppState>,
    Path(agent): Path<String>,
) -> Response {
    match routines::heartbeat(&state.engine, &agent) {
        Ok(view) => Json(json!({ "heartbeat": heartbeat_json(&view) })).into_response(),
        Err(error) => failure(&error),
    }
}

pub(super) async fn set_heartbeat(
    State(state): State<AppState>,
    Path(agent): Path<String>,
    Body(body): Body<HeartbeatBody>,
) -> Response {
    let quiet = match body.quiet {
        None => None,
        Some(None) => Some(None),
        Some(Some(Quiet { start, end })) => match (minute(&start), minute(&end)) {
            (Some(start), Some(end)) => Some(Some(QuietHours { start, end })),
            _ => return problem(StatusCode::BAD_REQUEST, "Quiet hours are written as HH:MM."),
        },
    };
    let change = HeartbeatInput {
        enabled: body.enabled,
        every_minutes: body.every_minutes,
        checklist: body.checklist,
        quiet,
        time_zone: body.time_zone,
    };
    match routines::set_heartbeat(&state.engine, &agent, change) {
        Ok(view) => Json(json!({ "heartbeat": heartbeat_json(&view) })).into_response(),
        Err(error) => failure(&error),
    }
}
