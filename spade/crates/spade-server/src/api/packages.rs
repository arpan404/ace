//! `/v1/agents/{id}/package` (ADR 0200 §3.9, §6.1; spade/docs/packages.md): a linked bot's
//! package, what an update or rollback would do, applying one, the person's effect switches,
//! and a withdrawn version's pause. The daemon's marketplace reviewed the bytes and the person
//! pressed Update, Roll back or Resume; nothing here is reached by a bot's tool.

use axum::Json;
use axum::Router;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::package::link::{Link, PackageId};

use super::body::{Body, Digested};
use super::{AppState, off_thread, problem};
use crate::packages::envelope::{self, Envelope};
use crate::packages::{self, PackageError, apply::Step, held::Asked};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/agents/{id}/package",
            get(read)
                .post(update)
                .layer(DefaultBodyLimit::max(super::agents::PACKAGE_BODY)),
        )
        .route("/agents/{id}/package/plan", post(plan))
        .route("/agents/{id}/package/template", get(template_update))
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
        PackageError::PersonOnly(_) => StatusCode::FORBIDDEN,
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

/// `GET /v1/agents/{id}/package/template`: the newer version of its template this Spade ships,
/// for the update review: `{package, recipe, plan, effects}`, what accepting it would do. `404` when it
/// has the newest, or wasn't made from a template.
async fn template_update(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    off_thread(move || {
        let offered = packages::link_of(&state.engine, &id).and_then(|link| {
            let shipped = packages::template::offered(&link).ok_or(PackageError::NotLinked)?;
            let plan = packages::plan_for(&state.engine, &id, &shipped.manifest)?;
            Ok((shipped, plan))
        });
        match offered {
            Ok((shipped, plan)) => Json(json!({
                "package": shipped.package,
                "recipe": shipped.recipe,
                "plan": plan,
                // Each switch as the update would leave it: what the person has on stays on,
                // anything new starts off.
                "effects": packages::effect_rows(&shipped.manifest, &plan.on),
            }))
            .into_response(),
            Err(PackageError::NotLinked) => problem(
                StatusCode::NOT_FOUND,
                "this Spade offers no newer version of its template",
            ),
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
    /// The version's panel pages (ADR 0200 §5.2), by path; kept once the step is accepted.
    #[serde(default)]
    pages: std::collections::BTreeMap<String, String>,
    /// The version's components (ADR 0203 §5), by path, in base64: kept now, pinned by the step.
    #[serde(default)]
    code: std::collections::BTreeMap<String, String>,
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
        // A template this Spade ships is proven by its built-in bytes, and only the version it
        // offers the bot is taken.
        None if body
            .package
            .as_ref()
            .is_some_and(|claimed| claimed.source == crate::teams::TEMPLATE_SOURCE) =>
        {
            let claimed = body.package.as_ref().ok_or_else(|| invalid("no package"))?;
            let shipped = packages::template::claimed(&link, claimed)?;
            if !body.recipe.is_null() && body.recipe != shipped.recipe {
                return Err(invalid("recipe isn't the template this Spade ships"));
            }
            return Ok((shipped.manifest.clone(), shipped.package.clone()));
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
            let pages = packages::panels::pages(&manifest, &body.pages)?;
            let pins = crate::code::accept::accepted(
                &manifest,
                &body.code,
                body.envelope.as_ref(),
                state.engine.code().as_deref(),
            )
            .map_err(PackageError::Invalid)?;
            let package = envelope::with_code(package, &pins);
            let asked = packages::held::ask(
                &state.engine,
                &id,
                Step {
                    manifest,
                    package,
                    proof: body.envelope.as_ref().and_then(packages::proof::kept),
                    transaction: body.transaction,
                    time_zone: body.time_zone,
                    code: pins,
                },
            )?;
            // Its pages are the accepted version's from now on, also while the step is held for
            // the bot's next still moment.
            packages::panels::keep(&state.engine, &id, &pages)?;
            Ok(asked)
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
    headers: HeaderMap,
    member: Option<axum::Extension<super::org_guard::Stamped>>,
    Digested(body, digest): Digested<SwitchBody>,
) -> Response {
    let stamp = headers
        .get(crate::security::attest::HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    off_thread(move || {
        // The person's stamp over this change, or on a shared bot the member whose `configure`
        // stamp let it through (ADR 0206 §2.3).
        let says = || {
            member.is_some()
                || state.engine.person_says(
                    stamp.as_deref(),
                    &id,
                    &format!("package_effect:{digest}"),
                )
        };
        answer(packages::set_switch(
            &state.engine,
            &id,
            &body.key,
            body.on,
            &says,
        ))
    })
    .await
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
