//! `/v1/agents/{id}/package` (ADR 0200 §3.9, §6.1; spade/docs/packages.md): a linked bot's
//! package, what an update or rollback would do, applying one, the person's effect switches,
//! and a withdrawn version's pause. The daemon's marketplace reviewed the bytes and the person
//! pressed Update, Roll back or Resume; nothing here is reached by a bot's tool.

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::package::link::{Link, PackageId};

use super::body::Body;
use super::{AppState, off_thread, problem};
use crate::packages::envelope::{self, Envelope};
use crate::packages::{self, PackageError, apply::Step, held::Asked};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/agents/{id}/package", get(read).post(update))
        .route("/agents/{id}/package/plan", post(plan))
        .route("/agents/{id}/package/effects", put(switch))
        .route(
            "/agents/{id}/package/withdrawn",
            post(withdraw).delete(resume),
        )
}

fn refused(error: &PackageError) -> Response {
    let status = match error {
        PackageError::NotFound | PackageError::NotLinked => StatusCode::NOT_FOUND,
        PackageError::Busy(_) => StatusCode::CONFLICT,
        PackageError::Invalid(_) | PackageError::Unproven(_) => StatusCode::BAD_REQUEST,
        PackageError::Failed(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    let message = error.to_string();
    (status, Json(json!({ "error": message, "detail": message }))).into_response()
}

fn answer(result: Result<Link, PackageError>) -> Response {
    match result {
        Ok(link) => Json(json!({ "package": packages::view(&link) })).into_response(),
        Err(error) => refused(&error),
    }
}

async fn read(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    off_thread(move || match packages::link_of(&state.engine, &id) {
        Ok(link) => {
            Json(json!({ "package": packages::shown(&state.engine, &id, &link) })).into_response()
        }
        Err(error) => refused(&error),
    })
    .await
}

#[derive(Deserialize)]
struct PlanBody {
    recipe: Value,
}

/// `POST /v1/agents/{id}/package/plan {recipe}`: what moving to this manifest would replace,
/// what stays because the person or the bot changed it, and what it asks for that starts off.
async fn plan(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<PlanBody>,
) -> Response {
    off_thread(move || {
        let planned = packages::manifest(&body.recipe)
            .and_then(|next| packages::plan_for(&state.engine, &id, &next));
        match planned {
            Ok(plan) => Json(json!({ "plan": plan })).into_response(),
            Err(error) => refused(&error),
        }
    })
    .await
}

#[derive(Deserialize)]
struct UpdateBody {
    #[serde(default)]
    recipe: Value,
    /// What the caller says the version is: believed only as `envelope` proves it.
    #[serde(default)]
    package: Option<PackageId>,
    /// The market's signed manifest and `bot.json` as it signed it (ADR 0200 §3.2).
    #[serde(default)]
    envelope: Option<Envelope>,
    transaction: String,
    #[serde(default)]
    time_zone: Option<String>,
}

/// The manifest and identity an update or rollback moves `bot` to: a market package's only from
/// the market's signature over those exact bytes, and of the same package; a local package's
/// from its manifest, never claiming a market identity.
fn proven(
    engine: &crate::engine::Engine,
    bot: &str,
    body: &UpdateBody,
) -> Result<(spade_core::package::Manifest, PackageId), PackageError> {
    let link = packages::link_of(engine, bot)?;
    let invalid = |why: &str| PackageError::Invalid(why.to_owned());
    let (package, recipe) = match &body.envelope {
        Some(sealed) => {
            let (package, recipe) = envelope::verify(sealed, &engine.market_keys())
                .map_err(|why| invalid(&format!("the version's identity isn't proven: {why}")))?;
            if !body.recipe.is_null() && body.recipe != recipe {
                return Err(invalid("recipe isn't the bot.json the market signed"));
            }
            if body.package.as_ref().is_some_and(|claimed| {
                (&claimed.name, &claimed.version, &claimed.hash)
                    != (&package.name, &package.version, &package.hash)
            }) {
                return Err(invalid("package isn't the version the market signed"));
            }
            if envelope::is_local(&link.package) || package.name != link.package.name {
                return Err(invalid(
                    "a bot moves only between versions of its own package",
                ));
            }
            (package, recipe)
        }
        None if body.package.is_some() || !envelope::is_local(&link.package) => {
            return Err(invalid(
                "a version's identity comes from the market's signed manifest (envelope)",
            ));
        }
        None => {
            let package = envelope::local(&body.recipe, &link.manifest.name);
            (package, body.recipe.clone())
        }
    };
    Ok((packages::manifest(&recipe)?, package))
}

fn transaction_ok(transaction: &str) -> bool {
    !transaction.is_empty()
        && transaction.len() <= 80
        && transaction
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// `POST /v1/agents/{id}/package {recipe, package, transaction}`: an update or a rollback the
/// person accepted, one step keyed by its transaction; held while the bot works (202).
async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<UpdateBody>,
) -> Response {
    if !transaction_ok(&body.transaction) {
        return problem(StatusCode::BAD_REQUEST, "a transaction is a short id");
    }
    off_thread(move || {
        let asked = proven(&state.engine, &id, &body).and_then(|(manifest, package)| {
            packages::held::ask(
                &state.engine,
                &id,
                Step {
                    manifest,
                    package,
                    proof: body.envelope.as_ref().and_then(packages::proof::kept),
                    transaction: body.transaction,
                    time_zone: body.time_zone,
                },
            )
        });
        // While the bot works the step is held for its next still moment: 202, saying so.
        let (status, link) = match asked {
            Ok(Asked::Applied(link)) => (StatusCode::OK, link),
            Ok(Asked::Held(link)) => (StatusCode::ACCEPTED, link),
            Err(error) => return refused(&error),
        };
        let shown = packages::shown(&state.engine, &id, &link);
        (status, Json(json!({ "package": shown }))).into_response()
    })
    .await
}

#[derive(Deserialize)]
struct SwitchBody {
    key: String,
    on: bool,
}

/// `PUT /v1/agents/{id}/package/effects {key, on}`: the person turns one declared effect on or
/// off for the bot.
async fn switch(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<SwitchBody>,
) -> Response {
    off_thread(move || answer(packages::set_switch(&state.engine, &id, &body.key, body.on))).await
}

#[derive(Deserialize)]
struct WithdrawBody {
    reason: String,
}

/// `POST /v1/agents/{id}/package/withdrawn {reason}`: its version was withdrawn; the bot is
/// paused with the reason, and nothing is deleted.
async fn withdraw(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Body(body): Body<WithdrawBody>,
) -> Response {
    off_thread(move || answer(packages::withdraw(&state.engine, &id, &body.reason))).await
}

/// `DELETE /v1/agents/{id}/package/withdrawn`: the person resumes it as it is.
async fn resume(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    off_thread(move || answer(packages::resume(&state.engine, &id))).await
}
