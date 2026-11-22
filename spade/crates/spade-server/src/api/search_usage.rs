//! `GET /v1/usage/search`: this month's ace searches against the allowance, for the quiet line in
//! Settings › Spade › General (ADR 0210 §6). Spade asks ace cloud with the person's grant; the
//! answer is `{signed_in, used, allowance, resets_at}`, with nulls when the cloud is away.

use axum::Json;
use axum::extract::State;
use axum::response::{IntoResponse, Response};

use super::AppState;

pub(super) async fn read(State(state): State<AppState>) -> Response {
    let usage = match &state.search {
        Some(search) => search.usage().await,
        None => spade_search::Usage::signed_out(),
    };
    Json(usage).into_response()
}
