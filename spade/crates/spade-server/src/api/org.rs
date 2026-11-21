//! Spade on an org host (ADR 0206): the organization it belongs to, its policy, shared bots and
//! their access lists, and the host's audit log. Changes to a shared bot carry a member's stamp
//! (`security::member`) over the request itself: `<METHOD> <path>` and the SHA-256 of its body,
//! so ace's daemon stamps any request it forwards for a member without knowing each route.

use axum::Json;
use axum::body::Bytes;
use axum::extract::{OriginalUri, Path, Query, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::org::Member;
use spade_core::org::audit::{Chained, Entry};

use super::{AppState, off_thread, problem};
use crate::engine::{AgentInput, OrgError};
use crate::org::{Binding, Offered};
use crate::security::{attest, member};

/// The member a write's stamp names, if it carries one good for exactly this request.
pub(super) fn stamped(
    state: &AppState,
    method: &Method,
    uri: &OriginalUri,
    headers: &HeaderMap,
    body: &[u8],
) -> Option<Member> {
    let text = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let target = format!("{method} {}", uri.0.path());
    let value = spade_core::org::audit::digest(body);
    state.engine.security()?.member_requests(
        text(member::REQUEST_HEADER),
        text(member::ROLE_HEADER),
        text(member::NAME_HEADER),
        &target,
        &value,
    )
}

/// The member whose answer stamp (ace's daemon's, on an org host) is their answer to `target`,
/// `allowed` and `always` as the body says.
pub(super) fn answered(
    state: &AppState,
    headers: &HeaderMap,
    target: &str,
    allowed: bool,
    always: bool,
) -> Option<Member> {
    let stamp = headers.get(member::HEADER).and_then(|v| v.to_str().ok());
    let mut found = state.engine.security()?.member_answers(
        stamp,
        target,
        &member::answer_value(allowed, always),
    )?;
    found.name = member::name(
        headers
            .get(member::NAME_HEADER)
            .and_then(|v| v.to_str().ok()),
    );
    Some(found)
}

fn org_problem(error: &OrgError) -> Response {
    let status = match error {
        OrgError::NotBound | OrgError::NotFound => StatusCode::NOT_FOUND,
        OrgError::PersonOnly | OrgError::MemberOnly(_) => StatusCode::FORBIDDEN,
        OrgError::Refused(_) | OrgError::Policy(_) => StatusCode::CONFLICT,
        OrgError::Invalid(_) => StatusCode::UNPROCESSABLE_ENTITY,
        OrgError::Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    problem(status, &error.to_string())
}

fn parse<T: for<'de> Deserialize<'de>>(body: &[u8]) -> Result<T, Box<Response>> {
    serde_json::from_slice(body)
        .map_err(|error| Box::new(problem(StatusCode::BAD_REQUEST, &error.to_string())))
}

/// `GET /v1/org`.
pub(super) async fn view(State(state): State<AppState>) -> Response {
    off_thread(move || Json(state.engine.org_view()).into_response()).await
}

/// `PUT /v1/org`: ace's daemon gives this Spade to an organization, with the owner's stamp.
pub(super) async fn bind(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(binding): Json<Binding>,
) -> Response {
    let stamp = headers
        .get(attest::HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    off_thread(
        move || match state.engine.bind_org(binding, stamp.as_deref()) {
            Ok(view) => Json(view).into_response(),
            Err(error) => org_problem(&error),
        },
    )
    .await
}

/// `DELETE /v1/org`: lets this Spade go from its organization, with the owner's stamp.
pub(super) async fn unbind(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let stamp = headers
        .get(attest::HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    off_thread(move || match state.engine.unbind_org(stamp.as_deref()) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => org_problem(&error),
    })
    .await
}

/// `PUT /v1/org/policy`: a policy version as the backend serves it; applied only when it
/// verifies and is newer.
pub(super) async fn policy(
    State(state): State<AppState>,
    Json(offered): Json<Offered>,
) -> Response {
    off_thread(move || match state.engine.offer_policy(&offered) {
        Ok(version) => Json(json!({ "version": version })).into_response(),
        Err(error) => org_problem(&error),
    })
    .await
}

#[derive(Deserialize)]
struct NewShared {
    name: String,
    #[serde(default)]
    task: String,
    #[serde(default)]
    model: Option<String>,
}

/// `POST /v1/org/bots`: a member makes a shared bot, with their stamp. It thinks only with a
/// model its organization allows.
pub(super) async fn create(
    State(state): State<AppState>,
    method: Method,
    uri: OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    off_thread(move || {
        let Some(member) = stamped(&state, &method, &uri, &headers, &body) else {
            return org_problem(&OrgError::MemberOnly(crate::engine::MEMBER_ONLY));
        };
        let wanted: NewShared = match parse(&body) {
            Ok(wanted) => wanted,
            Err(response) => return *response,
        };
        if state.engine.org_binding().is_none() {
            return org_problem(&OrgError::NotBound);
        }
        let input = AgentInput {
            name: wanted.name,
            task: wanted.task,
            model: wanted
                .model
                .unwrap_or_else(|| state.engine.new_bot_default()),
            avatar: None,
            naming: false,
        };
        let view = match state.engine.create_agent(input) {
            Ok(view) => view,
            Err(error) => return problem(StatusCode::BAD_REQUEST, &error.to_string()),
        };
        match state.engine.share_new_bot(&view.agent.id, &member) {
            Ok(access) => (
                StatusCode::CREATED,
                Json(json!({ "agent": { "id": view.agent.id, "name": view.agent.name }, "access": access })),
            )
                .into_response(),
            Err(error) => {
                // A bot that couldn't be shared isn't kept as anyone's.
                let engine = state.engine.clone();
                let id = view.agent.id.clone();
                if let Err(undo) = tokio::runtime::Handle::current()
                    .block_on(async move { engine.delete_agent(&id).await })
                {
                    tracing::warn!(%undo, "a bot that couldn't be shared could not be removed");
                }
                org_problem(&error)
            }
        }
    })
    .await
}

/// `GET /v1/agents/{id}/access`: a shared bot's access list, which the daemon reads to decide
/// whether to stamp a member's request.
pub(super) async fn access(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    off_thread(move || match state.engine.shared_access(&id) {
        Some(access) => Json(json!({ "access": access })).into_response(),
        None => problem(StatusCode::NOT_FOUND, "that bot isn't a shared bot"),
    })
    .await
}

#[derive(Deserialize)]
struct AccessChange {
    #[serde(default)]
    talk: Option<Vec<String>>,
    approvers: Vec<String>,
    #[serde(default)]
    configurers: Vec<String>,
}

/// `PUT /v1/agents/{id}/access`: a member who configures the bot changes its list.
pub(super) async fn set_access(
    State(state): State<AppState>,
    Path(id): Path<String>,
    method: Method,
    uri: OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    off_thread(move || {
        let Some(member) = stamped(&state, &method, &uri, &headers, &body) else {
            return org_problem(&OrgError::MemberOnly(crate::engine::MEMBER_ONLY));
        };
        let change: AccessChange = match parse(&body) {
            Ok(change) => change,
            Err(response) => return *response,
        };
        match state.engine.set_access(
            &id,
            &member,
            change.talk,
            change.approvers,
            change.configurers,
        ) {
            Ok(access) => Json(json!({ "access": access })).into_response(),
            Err(error) => org_problem(&error),
        }
    })
    .await
}

#[derive(Deserialize)]
pub(super) struct Recorded {
    entries: Vec<Entry>,
}

/// The longest batch the daemon records at once.
const MOST_RECORDED: usize = 100;

/// `POST /v1/org/audit`: entries the daemon records itself (membership seen, a host shell,
/// enrollment), each in WorkOS's limits.
pub(super) async fn record(State(state): State<AppState>, Json(body): Json<Recorded>) -> Response {
    if body.entries.is_empty() || body.entries.len() > MOST_RECORDED {
        return problem(StatusCode::BAD_REQUEST, "send one to 100 entries");
    }
    if let Some(bad) = body.entries.iter().find(|entry| !plain_entry(entry)) {
        return problem(
            StatusCode::UNPROCESSABLE_ENTITY,
            &format!("{} isn't an entry the audit log takes", bad.action),
        );
    }
    off_thread(move || match state.engine.org_record(&body.entries) {
        Ok(chained) => Json(json!({ "count": chained.len() })).into_response(),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    })
    .await
}

/// An entry as the backend's audit route takes one: a dotted action word, one to ten targets,
/// at most 49 metadata keys.
fn plain_entry(entry: &Entry) -> bool {
    let words: Vec<&str> = entry.action.split('.').collect();
    (2..=4).contains(&words.len())
        && words
            .iter()
            .all(|w| !w.is_empty() && w.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'))
        && (1..=10).contains(&entry.targets.len())
        && entry.metadata.len() <= 49
        // Spade's own actions are Spade's to write.
        && !entry.action.starts_with("bot.")
        && entry.action != "audit.checkpoint"
}

#[derive(Deserialize)]
pub(super) struct Limit {
    #[serde(default)]
    limit: Option<usize>,
}

/// An entry as `POST /v1/orgs/{org}/audit` takes it (`AceOrgAuditEntry`), with its place.
fn outgoing(chained: &Chained) -> Value {
    let mut value = serde_json::to_value(&chained.entry).unwrap_or(Value::Null);
    if let Some(object) = value.as_object_mut() {
        object.insert("hash".to_owned(), json!(chained.hash));
        object.insert("seq".to_owned(), json!(chained.seq));
    }
    value
}

/// `GET /v1/org/audit/outbox`: what the daemon forwards to the backend next, oldest first.
pub(super) async fn outbox(State(state): State<AppState>, Query(q): Query<Limit>) -> Response {
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    off_thread(move || match state.engine.org_outbox(limit) {
        Ok(entries) => Json(json!({ "entries": entries.iter().map(outgoing).collect::<Vec<_>>() }))
            .into_response(),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    })
    .await
}

#[derive(Deserialize)]
pub(super) struct Forwarded {
    through: i64,
}

/// `POST /v1/org/audit/forwarded`: the backend took every entry through `through`.
pub(super) async fn forwarded(
    State(state): State<AppState>,
    Json(body): Json<Forwarded>,
) -> Response {
    off_thread(move || match state.engine.org_forwarded(body.through) {
        Ok(count) => Json(json!({ "forwarded": count })).into_response(),
        Err(error) => problem(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    })
    .await
}

#[derive(Deserialize)]
pub(super) struct Span {
    #[serde(default)]
    from: Option<i64>,
    #[serde(default)]
    to: Option<i64>,
}

/// `GET /v1/org/audit/export?from=&to=`: the log as JSON Lines, for `ace org audit export`.
pub(super) async fn export(State(state): State<AppState>, Query(span): Query<Span>) -> Response {
    let (from, to) = (span.from.unwrap_or(0), span.to.unwrap_or(i64::MAX));
    off_thread(move || match state.engine.org_export(from, to) {
        Ok(text) => ([(header::CONTENT_TYPE, "application/x-ndjson")], text).into_response(),
        Err(error) => problem(StatusCode::NOT_FOUND, &error),
    })
    .await
}
