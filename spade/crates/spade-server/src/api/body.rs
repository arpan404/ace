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

/// For `Option<Option<T>>` fields: absent is `None`, `null` is `Some(None)`.
pub(super) fn present<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}
