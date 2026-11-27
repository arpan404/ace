// SPDX-License-Identifier: Apache-2.0
//! `options.resolveSilenceMs` as the silence thresholds' resolver: the setting that applies to a
//! thread, a workspace or the whole home, asked over the port and read back as a number.

use ace_json::Value;
use std::rc::Rc;

use crate::EngineError;
use crate::futures::future::LocalBoxFuture;
use crate::meters::silence::{SilenceResolver, SilenceScope};
use crate::ports::{PortError, Ports};

/// `resolveSilenceMs(scope)`: the setting that applies, or `None` when nothing overrides.
pub struct PortSilenceResolver {
    ports: Rc<dyn Ports>,
}

impl PortSilenceResolver {
    pub fn new(ports: Rc<dyn Ports>) -> PortSilenceResolver {
        PortSilenceResolver { ports }
    }
}

impl SilenceResolver for PortSilenceResolver {
    fn resolve(&self, scope: SilenceScope) -> LocalBoxFuture<'static, Result<Option<f64>, String>> {
        let ports = Rc::clone(&self.ports);
        let json = ace_json::to_string(&scope_json(&scope));
        Box::pin(async move {
            let answer = ports
                .resolve_silence_ms(&json)
                .await
                .map_err(|error| error.to_string())?;
            answer_ms(&answer).map_err(|error| error.to_string())
        })
    }
}

/// The scope a resolver is asked about, in the option's own keys.
pub fn scope_json(scope: &SilenceScope) -> Value {
    let mut value = ace_json::Map::new();
    if let Some(thread_id) = &scope.thread_id {
        value.insert("threadId", Value::from(thread_id.as_str()));
    }
    if let Some(workspace_id) = &scope.workspace_id {
        value.insert("workspaceId", Value::from(workspace_id.as_str()));
    }
    Value::Object(value)
}

/// The resolver's answer: `null` (or nothing) leaves the setting alone; a number applies it.
pub fn answer_ms(answer: &str) -> Result<Option<f64>, EngineError> {
    let parsed = ace_json::parse(answer)
        .map_err(|error| EngineError::Port(PortError::Threw(error.to_string())))?;
    match parsed {
        Value::Null => Ok(None),
        value => value
            .as_f64()
            .map(Some)
            .ok_or_else(|| EngineError::Port(PortError::Threw("Invalid silenceMs".to_owned()))),
    }
}

#[cfg(test)]
mod tests {
    use super::{answer_ms, scope_json};
    use crate::meters::silence::SilenceScope;
    use ace_json::Value;

    #[test]
    fn a_scope_names_only_the_layers_it_asks_about() {
        assert_eq!(
            ace_json::to_string(&scope_json(&SilenceScope::default())),
            "{}"
        );
        let thread = SilenceScope {
            thread_id: Some("t".to_owned()),
            workspace_id: Some("w".to_owned()),
        };
        assert_eq!(
            ace_json::to_string(&scope_json(&thread)),
            r#"{"threadId":"t","workspaceId":"w"}"#
        );
    }

    #[test]
    fn an_answer_is_a_number_or_nothing_at_all() {
        assert_eq!(answer_ms("120000").expect("a number"), Some(120_000.0));
        assert_eq!(answer_ms("null").expect("none"), None);
        assert!(answer_ms("\"soon\"").is_err());
        assert_eq!(
            answer_ms("{}").unwrap_err().to_string(),
            "Invalid silenceMs"
        );
        // The parse keeps JSON's own numbers.
        let _ = Value::Null;
    }
}
