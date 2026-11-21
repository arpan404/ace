//! A shared bot changes only on a member's say (ADR 0206 §2.3). Every write to a shared bot
//! (`/v1/agents/{id}/…`: its grants, switches, Full access, routines, model, files) takes a
//! member's stamp with `configure` on it, and every write to its conversation (a message, Stop)
//! one with `talk`; the person's stamp counts for nothing there. The member the stamp proved is
//! passed on to the route, which never reads the stamp again (each is good once).
//!
//! A club led by a shared bot takes the same: `talk` on its lead to post, `configure` to change
//! it. Its approvals and its access list check their own stamps, for the right each needs.

use axum::body::Body;
use axum::extract::{OriginalUri, Request, State};
use axum::http::{Method, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use spade_core::org::{Member, Right};

use super::{AppState, problem};

/// The member whose stamp let a write to a shared bot through.
#[derive(Debug, Clone)]
pub struct Stamped(pub Member);

/// The most a write to a shared bot may carry for its stamp to be checked: the largest upload
/// a bot's routes take.
const MOST_BYTES: usize = 64 * 1024 * 1024;

/// Which shared bot a request writes to, and the right it needs; `None` for anything else.
fn writes_to(state: &AppState, method: &Method, path: &str) -> Option<(String, Right)> {
    if *method == Method::GET || *method == Method::HEAD {
        return None;
    }
    let mut parts = path.trim_start_matches('/').split('/');
    match (parts.next(), parts.next(), parts.next()) {
        // Checked by their own routes, with their own rights.
        (Some("agents"), Some(_), Some("access")) => None,
        (Some("conversations"), Some(_), Some("approvals")) => None,
        // Moving a shared bot is the organization's admins' (`move`).
        (Some("agents"), Some(id), Some("move")) => {
            let id = id.to_owned();
            state.engine.shared_access(&id).map(|_| (id, Right::Move))
        }
        (Some("agents"), Some(id), _) => {
            let id = id.to_owned();
            state
                .engine
                .shared_access(&id)
                .map(|_| (id, Right::Configure))
        }
        // A club led by a shared bot is a shared club: posting to it takes `talk` on its lead,
        // changing it `configure`.
        (Some("groups"), Some(id), rest) => {
            let lead = state.engine.club_lead(id)?;
            state.engine.shared_access(&lead)?;
            let right = match rest {
                Some("messages" | "stop") => Right::Talk,
                _ => Right::Configure,
            };
            Some((lead, right))
        }
        (Some("conversations"), Some(conversation), _) => {
            let (agent, _) = state.engine.shared_over(conversation)?;
            Some((agent, Right::Talk))
        }
        _ => None,
    }
}

pub(super) async fn guard(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    let Some((agent, right)) = writes_to(&state, request.method(), &path) else {
        return next.run(request).await;
    };
    let (parts, body) = request.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, MOST_BYTES).await else {
        return problem(StatusCode::PAYLOAD_TOO_LARGE, "that request is too large");
    };
    let uri = parts
        .extensions
        .get::<OriginalUri>()
        .cloned()
        .unwrap_or_else(|| OriginalUri(parts.uri.clone()));
    let checked = {
        let (state, method, headers, bytes, agent) = (
            state.clone(),
            parts.method.clone(),
            parts.headers.clone(),
            bytes.clone(),
            agent.clone(),
        );
        tokio::task::spawn_blocking(move || {
            let member = super::org::stamped(&state, &method, &uri, &headers, &bytes)?;
            state
                .engine
                .member_may(&agent, &member, right)
                .then_some(member)
        })
        .await
        .ok()
        .flatten()
    };
    let Some(member) = checked else {
        return problem(StatusCode::FORBIDDEN, crate::engine::MEMBER_ONLY);
    };
    let configured = (right == Right::Configure)
        .then(|| configured_part(&parts.method, &path))
        .flatten();
    let mut request = Request::from_parts(parts, Body::from(bytes));
    request.extensions_mut().insert(Stamped(member.clone()));
    let response = next.run(request).await;
    // What it changed is on the host's log once it took (ADR 0206 §4.1). Steps that record
    // themselves with the change (package steps, a move, deleting it) aren't recorded again.
    if let Some(changed) = configured
        && response.status().is_success()
    {
        let engine = state.engine.clone();
        let recorded =
            tokio::task::spawn_blocking(move || engine.org_configured(&agent, &member, changed))
                .await;
        if !matches!(recorded, Ok(Ok(()))) {
            tracing::warn!("a shared bot's change couldn't be recorded on the audit log");
        }
    }
    response
}

/// The part of a shared bot a configure write changes, by its route: `grants`, `security`,
/// `routines`, `club`…; `None` for a write that records itself.
fn configured_part(method: &Method, path: &str) -> Option<&'static str> {
    let mut parts = path.trim_start_matches('/').split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some("agents"), Some(_), None) if *method == Method::DELETE => None,
        (Some("agents"), Some(_), None) => Some("profile"),
        (Some("agents"), Some(_), Some("package" | "move" | "access")) => None,
        (Some("agents"), Some(_), Some(part)) => Some(match part {
            "grants" => "grants",
            "security" => "security",
            "routines" => "routines",
            "model" | "models" => "model",
            "task" => "task",
            "files" => "files",
            "notes" => "notes",
            "pin" => "pin",
            _ => "settings",
        }),
        (Some("groups"), Some(_), _) => Some("club"),
        _ => None,
    }
}
