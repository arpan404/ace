//! OAuth Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document, which the
//! MCP authorization spec ranks before dynamic registration). Spade's client ID is the `https`
//! address of a public JSON document on acehq.dev (ADR 0136) naming Spade and its loopback
//! callback. A server that supports it fetches the document itself, so Spade registers nothing.
//!
//! The document lists one callback for every connector, `http://127.0.0.1/v1/connectors/callback`
//! (any port, RFC 8252 section 7.3), because a document can't list the per-connector addresses
//! Spade uses otherwise. The `state` picks the sign-in, and `iss` must name the server it began
//! with: the client ID and callback being the same everywhere, nothing else could tell one
//! server's answer from another's.

use super::{AuthServer, Client};

/// Spade's client ID: the address of its metadata document, which names itself there.
/// `SPADE_CLIENT_METADATA_URL` replaces it in development; tests pass their own.
pub const CLIENT_METADATA_URL: &str = "https://acehq.dev/oauth/spade.json";

/// Whether to sign in to `server` as the metadata document rather than register: it must say it
/// fetches them, and either name itself in its answers or offer no registration to fall back on.
/// A server that supports both but is quiet about `iss` keeps the per-connector callback that
/// registration gives, which tells answers apart without `iss`.
pub fn usable(server: &AuthServer) -> bool {
    server.client_id_metadata_document_supported == Some(true)
        && (server.authorization_response_iss_parameter_supported == Some(true)
            || server.registration_endpoint.is_none())
}

/// The client for the document at `url`: public, no secret, nothing registered.
pub fn client(url: &str) -> Client {
    Client {
        id: url.to_owned(),
        secret: None,
        auth_method: "none".into(),
        registered_redirect: None,
        metadata_document: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(cimd: Option<bool>, iss: Option<bool>, registration: bool) -> AuthServer {
        AuthServer {
            issuer: "https://auth.example.com".into(),
            authorization_endpoint: "https://auth.example.com/authorize".into(),
            token_endpoint: "https://auth.example.com/token".into(),
            registration_endpoint: registration.then(|| "https://auth.example.com/reg".into()),
            code_challenge_methods_supported: Some(vec!["S256".into()]),
            scopes_supported: None,
            token_endpoint_auth_methods_supported: None,
            authorization_response_iss_parameter_supported: iss,
            client_id_metadata_document_supported: cimd,
            device_authorization_endpoint: None,
        }
    }

    #[test]
    fn the_document_is_used_only_where_the_server_fetches_it_and_answers_can_be_told_apart() {
        assert!(usable(&server(Some(true), Some(true), true)));
        assert!(
            usable(&server(Some(true), None, false)),
            "nothing else to try"
        );
        assert!(
            !usable(&server(Some(true), None, true)),
            "registration keeps answers apart without iss"
        );
        assert!(!usable(&server(Some(false), Some(true), false)));
        assert!(!usable(&server(None, Some(true), true)));
    }
}
