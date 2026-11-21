//! JSON bodies parsed into typed structs, refused as a problem (`{"error"}`) when they do not fit.
//! Unknown fields are ignored, so newer clients keep working.

use axum::Json;
use axum::extract::{FromRequest, Request};
use axum::response::Response;
use serde::de::{Deserialize, DeserializeOwned, Deserializer};

use super::problem;

pub(super) struct Body<T>(pub T);

impl<S, T> FromRequest<S> for Body<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = Response;

    async fn from_request(request: Request, state: &S) -> Result<Self, Response> {
        match Json::<T>::from_request(request, state).await {
            Ok(Json(value)) => Ok(Self(value)),
            Err(rejection) => {
                let text: String = rejection
                    .body_text()
                    .replace('\n', " ")
                    .chars()
                    .take(300)
                    .collect();
                Err(problem(rejection.status(), &text))
            }
        }
    }
}

/// A JSON body as [`Body`] reads it, with the SHA-256 of its bytes as sent (lower-case hex): what
/// ace's daemon stamps a person's change over (`security::attest`), so the stamp holds for these
/// bytes and no others.
pub(super) struct Digested<T>(pub T, pub String);

impl<S, T> FromRequest<S> for Digested<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = Response;

    async fn from_request(request: Request, state: &S) -> Result<Self, Response> {
        use axum::http::StatusCode;
        use sha2::{Digest, Sha256};
        let bytes = axum::body::Bytes::from_request(request, state)
            .await
            .map_err(|_| problem(StatusCode::BAD_REQUEST, "The body couldn't be read."))?;
        let value = serde_json::from_slice::<T>(&bytes).map_err(|error| {
            let text: String = error.to_string().chars().take(300).collect();
            problem(StatusCode::UNPROCESSABLE_ENTITY, &text)
        })?;
        let digest = Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok(Self(value, digest))
    }
}

/// For `Option<Option<T>>` fields: absent is `None`, `null` is `Some(None)`.
pub(super) fn present<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}
