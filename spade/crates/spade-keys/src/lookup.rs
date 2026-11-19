//! Finding an endpoint's key: the OS keychain first, then the endpoint's environment variable
//! (ADR 0119). Used by model endpoints and search backends alike.

use std::fmt;
use std::sync::Arc;

/// Which key a call needs: the endpoint's id, and the environment variable it may name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyRequest<'a> {
    pub endpoint: &'a str,
    pub env: Option<&'a str>,
}

/// A key lookup for an endpoint.
type Lookup = dyn Fn(KeyRequest<'_>) -> Option<String> + Send + Sync;

/// Finds an endpoint's key: in Spade, the OS keychain first and then the endpoint's environment
/// variable (ADR 0119). Keys are never printed.
#[derive(Clone)]
pub struct Keys(Arc<Lookup>);

impl Keys {
    pub fn new(lookup: impl Fn(KeyRequest<'_>) -> Option<String> + Send + Sync + 'static) -> Self {
        Self(Arc::new(lookup))
    }

    /// The OS keychain first, looked up by endpoint id, then the endpoint's environment variable
    /// (ADR 0119). A blank keychain entry falls through to the variable.
    pub fn keychain_then_env(
        keychain: impl Fn(&str) -> Option<String> + Send + Sync + 'static,
        env: impl Fn(&str) -> Option<String> + Send + Sync + 'static,
    ) -> Self {
        let present = |value: String| (!value.trim().is_empty()).then_some(value);
        Self::new(move |request| {
            keychain(request.endpoint)
                .and_then(present)
                .or_else(|| request.env.and_then(&env))
        })
    }

    /// Keys from this process's environment only.
    pub fn from_process_env() -> Self {
        Self::new(|request| request.env.and_then(|name| std::env::var(name).ok()))
    }

    /// The key for `endpoint` (or its variable `env`), looked up on tokio's blocking pool: a
    /// keychain read can block for as long as a prompt waits, and must never hold up an async
    /// worker. Use this from async code; [`Keys::get`] from blocking code.
    pub async fn find(&self, endpoint: &str, env: Option<&str>) -> Option<String> {
        let (keys, endpoint, env) = (self.clone(), endpoint.to_owned(), env.map(str::to_owned));
        tokio::task::spawn_blocking(move || {
            keys.get(KeyRequest {
                endpoint: &endpoint,
                env: env.as_deref(),
            })
        })
        .await
        .ok()
        .flatten()
    }

    /// The key for `request`, if found and not blank. Blocks while the keychain does.
    pub fn get(&self, request: KeyRequest<'_>) -> Option<String> {
        (self.0)(request)
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    }
}

impl fmt::Debug for Keys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Keys(…)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lookup(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| {
            pairs
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| (*v).to_owned())
        }
    }

    #[test]
    fn the_keychain_wins_then_the_environment_is_used() {
        let keys = Keys::keychain_then_env(
            lookup(&[("openai", "from-keychain"), ("blank", "  ")]),
            lookup(&[
                ("OPENAI_API_KEY", "from-env"),
                ("BLANK_KEY", "blank-env"),
                ("GO_KEY", "go-env"),
            ]),
        );
        let get = |endpoint, env| keys.get(KeyRequest { endpoint, env });
        assert_eq!(
            get("openai", Some("OPENAI_API_KEY")),
            Some("from-keychain".to_owned())
        );
        assert_eq!(
            get("opencode-go", Some("GO_KEY")),
            Some("go-env".to_owned())
        );
        assert_eq!(
            get("blank", Some("BLANK_KEY")),
            Some("blank-env".to_owned())
        );
        assert_eq!(get("opencode-go", None), None);
    }

    #[test]
    fn a_blank_key_counts_as_missing() {
        let keys = Keys::new(|request| (request.endpoint == "openai").then(|| "   ".to_owned()));
        let request = KeyRequest {
            endpoint: "openai",
            env: Some("OPENAI_API_KEY"),
        };
        assert_eq!(keys.get(request), None);
    }
}
