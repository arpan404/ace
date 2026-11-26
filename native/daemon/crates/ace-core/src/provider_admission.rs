// SPDX-License-Identifier: Apache-2.0
//! The enablement policy shared by real and fake command admission (`provider-admission.ts`,
//! ported for E5.4d): whether a command names a provider or account the person turned off.

use ace_json::Value;

/// A thread as the policy reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderThread {
    pub provider: String,
    pub instance_id: Option<String>,
    pub parent_thread_id: Option<String>,
}

/// What the policy asks the engine.
pub trait ProviderAdmissionFacts {
    fn thread(&self, id: &str) -> Option<ProviderThread>;
    /// A port that throws answers `Err` with its message; the receipt rolls back.
    fn default_instance(&self, provider: &str) -> Result<Option<String>, String>;
    /// A port that throws answers `Err` with its message; the receipt rolls back.
    fn enabled(&self, provider: &str, instance: Option<&str>) -> Result<bool, String>;
}

/// `providerCommandDisabled`: a command that would reach a disabled provider or account.
pub fn provider_command_disabled(
    payload: &Value,
    facts: &dyn ProviderAdmissionFacts,
) -> Result<bool, String> {
    let kind = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(
        kind,
        "thread.create"
            | "thread.prepare"
            | "thread.send"
            | "thread.fork"
            | "thread.switch"
            | "thread.resume"
            | "queue.resume"
            | "thread.merge"
            | "thread.model.set"
            | "thread.mode.set"
            | "thread.goal.set"
            | "thread.goal.clear"
    ) {
        return Ok(false);
    }
    let thread = payload
        .get("threadId")
        .and_then(Value::as_str)
        .and_then(|id| facts.thread(id));
    let selection = payload.get("selection");
    let text = |value: Option<&Value>| value.and_then(Value::as_str).map(str::to_owned);
    let provider = text(payload.get("provider"))
        .or_else(|| {
            selection
                .and_then(|selection| selection.get("provider"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .or_else(|| thread.as_ref().map(|thread| thread.provider.clone()));
    let mut instance = text(payload.get("instanceId"))
        .or_else(|| text(payload.get("accountId")))
        .or_else(|| text(payload.get("account")))
        .or_else(|| {
            selection
                .and_then(|selection| selection.get("instanceId"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .or_else(|| {
            thread.as_ref().and_then(|thread| {
                (Some(thread.provider.as_str()) == provider.as_deref())
                    .then(|| thread.instance_id.clone())
                    .flatten()
            })
        });
    if instance.is_none()
        && let Some(provider) = provider.as_deref()
    {
        instance = facts.default_instance(provider)?;
    }
    if let Some(provider) = provider.as_deref()
        && !facts.enabled(provider, instance.as_deref())?
    {
        return Ok(true);
    }
    // Both the contributing fork and the parent receiving context/patches must be enabled.
    if kind == "thread.merge"
        && let Some(parent) = thread
            .as_ref()
            .and_then(|thread| thread.parent_thread_id.as_deref())
        && let Some(destination) = facts.thread(parent)
    {
        let instance = match destination.instance_id.clone() {
            Some(instance) => Some(instance),
            None => facts.default_instance(&destination.provider)?,
        };
        if !facts.enabled(&destination.provider, instance.as_deref())? {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Facts {
        disabled: bool,
    }

    impl ProviderAdmissionFacts for Facts {
        fn thread(&self, id: &str) -> Option<ProviderThread> {
            (id == "t").then(|| ProviderThread {
                provider: "codex".into(),
                instance_id: Some("account".into()),
                parent_thread_id: None,
            })
        }
        fn default_instance(&self, _provider: &str) -> Result<Option<String>, String> {
            Ok(None)
        }
        fn enabled(&self, _provider: &str, _instance: Option<&str>) -> Result<bool, String> {
            Ok(!self.disabled)
        }
    }

    fn value(text: &str) -> Value {
        ace_json::parse(text).expect("json")
    }

    #[test]
    fn an_enabled_provider_takes_the_command_and_a_disabled_one_refuses_it() {
        let send = value(r#"{"type":"thread.send","threadId":"t","input":[]}"#);
        assert!(!provider_command_disabled(&send, &Facts { disabled: false }).expect("enabled"));
        assert!(provider_command_disabled(&send, &Facts { disabled: true }).expect("answered"));
        // A command that reaches no provider is never disabled.
        let archive = value(r#"{"type":"thread.archive","threadId":"t"}"#);
        assert!(!provider_command_disabled(&archive, &Facts { disabled: true }).expect("answered"));
    }
}
