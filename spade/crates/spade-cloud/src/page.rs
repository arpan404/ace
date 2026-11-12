//! The page the person's browser lands on after the maker redirects back. Plain words, no links,
//! no scripts, never cached, and no referrer, so the code in its address goes nowhere else.

use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};

pub enum Page {
    SignedIn,
    Declined,
    Invalid,
}

impl IntoResponse for Page {
    fn into_response(self) -> Response {
        let (status, title, line) = match self {
            Page::SignedIn => (
                StatusCode::OK,
                "Signed in",
                "Signed in. You can close this tab.",
            ),
            Page::Declined => (
                StatusCode::OK,
                "Sign-in cancelled",
                "The sign-in was cancelled. You can close this tab and try again from Spade.",
            ),
            Page::Invalid => (
                StatusCode::BAD_REQUEST,
                "Sign-in not found",
                "This sign-in has expired or was already used. Start again from Spade.",
            ),
        };
        let body = format!(
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>{title}</title><style>body{{font:16px system-ui,sans-serif;margin:20vh auto;max-width:28rem;padding:0 1rem;color:#222;background:#fff}}@media(prefers-color-scheme:dark){{body{{color:#eee;background:#111}}}}</style></head><body><p>{line}</p></body></html>"
        );
        let mut response = (status, body).into_response();
        let headers = response.headers_mut();
        for (name, value) in [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
            ),
        ] {
            headers.insert(name, HeaderValue::from_static(value));
        }
        response
    }
}
