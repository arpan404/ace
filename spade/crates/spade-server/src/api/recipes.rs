//! `POST /v1/agents` with `recipe` (ADR 0168, docs/teams.md): a new bot from a marketplace recipe
//! the daemon reviewed, with the grants the person left on. Answers `201 {agent, left_out}` as a
//! template does; a refusal makes no bot.

use std::time::Duration;

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

use super::agents::agent_json;
use super::{AppState, off_thread};
use crate::engine::{AgentError, FromRecipe};
use crate::teams::{self, PortableError, RecipeGrants, RecipeInput};

/// How long making a bot waits for ace's plugins before going on with the last reading.
const WAIT: Duration = Duration::from_secs(5);

/// The recipe parts of a `POST /v1/agents` body.
pub(super) struct RecipeBody {
    pub recipe: Value,
    pub from_recipe: Option<FromRecipe>,
    pub grants: RecipeGrants,
    pub start_routines: bool,
    pub time_zone: Option<String>,
    pub package: Option<spade_core::package::link::PackageId>,
    pub envelope: Option<crate::packages::envelope::Envelope>,
    pub switches: std::collections::BTreeMap<String, bool>,
    /// A package's panel pages, by path.
    pub pages: std::collections::BTreeMap<String, String>,
    /// The body also named a template or a first message, which a recipe doesn't take.
    pub also: bool,
}

/// A refusal, its words under `error` as every Spade answer has them and under `detail`, which
/// the daemon's marketplace reads.
fn refused(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message, "detail": message }))).into_response()
}

fn portable_status(error: &PortableError) -> StatusCode {
    match error {
        PortableError::NotFound => StatusCode::NOT_FOUND,
        PortableError::Invalid(_) => StatusCode::BAD_REQUEST,
        PortableError::Agent(AgentError::Invalid(_) | AgentError::Image(_)) => {
            StatusCode::BAD_REQUEST
        }
        PortableError::Agent(AgentError::NotFound) => StatusCode::NOT_FOUND,
        PortableError::Agent(
            AgentError::Main(_) | AgentError::HasWorkers(_) | AgentError::Terms { .. },
        ) => StatusCode::CONFLICT,
        PortableError::Agent(AgentError::Store(_)) | PortableError::Failed(_) => {
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

pub(super) async fn create(state: AppState, body: RecipeBody) -> Response {
    if body.also {
        return refused(
            StatusCode::BAD_REQUEST,
            "a bot is made from a recipe or a template, and a recipe's bot has no first message",
        );
    }
    let Some(from_recipe) = body.from_recipe else {
        return refused(
            StatusCode::BAD_REQUEST,
            "a recipe's bot records where it came from: from_recipe {source, name, version}",
        );
    };
    // A transaction already made its bot: answer with that bot, make no second one.
    if let Some(transaction) = from_recipe.transaction.as_deref() {
        if transaction.is_empty()
            || transaction.len() > 80
            || !transaction
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return refused(
                StatusCode::BAD_REQUEST,
                "an install transaction is a short id",
            );
        }
        let found = state.engine.bot_for_transaction(transaction);
        match found {
            // Never shown half made: its install is still putting it together.
            Ok(Some(id)) if state.engine.installing(&id) => {
                return refused(StatusCode::CONFLICT, "that install is still under way");
            }
            Ok(Some(id)) => {
                return match state.engine.agent_view(&id) {
                    Ok(Some(view)) => (
                        StatusCode::OK,
                        Json(json!({ "agent": agent_json(&view), "left_out": [] })),
                    )
                        .into_response(),
                    Ok(None) => refused(StatusCode::CONFLICT, "the transaction's bot just went"),
                    Err(error) => refused(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
                };
            }
            Ok(None) => {}
            Err(error) => return refused(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
        }
    }
    // The daemon has just accepted these plugins, so the last reading may not have them yet.
    if !body.grants.plugins.is_empty()
        && let Some(plugins) = state.engine.plugins()
    {
        let _ = tokio::time::timeout(WAIT, plugins.refresh_now()).await;
    }
    let input = RecipeInput {
        recipe: body.recipe,
        from_recipe,
        grants: body.grants,
        start_routines: body.start_routines,
        time_zone: body.time_zone,
        package: body.package,
        envelope: body.envelope,
        shipped: None,
        switches: body.switches,
        pages: body.pages,
    };
    let made_state = state.clone();
    let answer = off_thread(move || {
        let state = made_state;
        match teams::from_recipe(
            &state.engine,
            state.connectors.as_deref(),
            state.engine.plugins().map(|p| &**p),
            input,
        ) {
            Ok(made) => (
                StatusCode::CREATED,
                Json(json!({ "agent": agent_json(&made.agent), "left_out": made.left_out })),
            )
                .into_response(),
            Err(error) => refused(portable_status(&error), &error.to_string()),
        }
    })
    .await;
    // A recipe's own skills were just installed in the marketplace: copy them now, not at the
    // next notice.
    if answer.status() == StatusCode::CREATED
        && let Some(store) = state.skill_store.clone()
    {
        tokio::spawn(async move {
            if let Err(error) = store.market_now().await {
                tracing::debug!(%error, "market skills wait for the next sync");
            }
        });
    }
    answer
}
