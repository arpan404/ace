// SPDX-License-Identifier: Apache-2.0
//! `provider-errors.ts`: provider failures normalized once, keeping the native evidence and both
//! notice contracts. Provider codes are authoritative only in notices and errors, never in
//! assistant prose. Moved cases: `open-failure.process.test.ts`'s structured-failure case.

use ace_json::Value;

const PROVIDERS: [(&str, &str); 7] = [
    ("claude", "Claude"),
    ("codex", "Codex"),
    ("pi", "Pi"),
    ("opencode", "OpenCode"),
    ("cursor", "Cursor"),
    ("antigravity", "Antigravity"),
    ("acp", "The provider"),
];

/// The provider's display name.
fn name(provider: &str) -> &str {
    PROVIDERS
        .iter()
        .find(|(kind, _)| *kind == provider)
        .map(|(_, name)| *name)
        .unwrap_or("The provider")
}

/// What a provider code reads as, with the details the notice carries.
struct Readable {
    text: String,
    code: String,
    model: Option<String>,
}

/// `readable`: a provider code and its metadata, in the person's words.
fn readable(provider: &str, text: &str, selected_model: Option<&str>) -> Option<Readable> {
    let trimmed = text.trim();
    let (code, rest) = tag(trimmed);
    let mut model = selected_model.map(str::to_owned);
    if let Some(rest) = rest
        && rest.encode_utf16().count() <= 8192
        && let Ok(Value::Object(metadata)) = ace_json::parse(rest)
        && let Some(Value::String(found)) = metadata.get("model")
    {
        // `z.string().min(1).max(256)` counts code points (rule 17).
        let points = found.as_str().chars().count();
        if (1..=256).contains(&points) {
            model = Some(found.as_str().to_owned());
        }
    }
    let name = name(provider);
    let quoted = |model: &Option<String>| {
        model
            .as_ref()
            .map(|model| format!(" \"{model}\""))
            .unwrap_or_default()
    };
    let message = match code {
        "unrecognized_model" | "model_not_found" => format!(
            "{name} could not use the selected model{}. Choose an available model or check this account's model access.",
            quoted(&model)
        ),
        "authentication_failed" => {
            format!("{name} could not authenticate. Sign in again using the provider's own CLI.")
        }
        "billing_error" => format!(
            "{name} stopped because this account has a billing issue. Check the account in the provider's CLI or dashboard."
        ),
        "rate_limit" => format!(
            "{name} reached an account limit. Wait for the limit to reset or select another eligible account."
        ),
        "model_quota" => format!(
            "This {name} account is out of usage for {}. Choose another model{}, or raise the account's limit.",
            model
                .as_ref()
                .map(|model| format!("\"{model}\""))
                .unwrap_or_else(|| "the selected model".to_owned()),
            if provider == "cursor" {
                " (Cursor suggests Auto)"
            } else {
                ""
            }
        ),
        "overloaded_error" => format!("{name} is temporarily overloaded. Try again shortly."),
        _ => return None,
    };
    Some(Readable {
        text: message,
        code: code.to_owned(),
        model,
    })
}

/// The `[tag:code] metadata` form, when the text carries one: the code and the rest.
fn tag(text: &str) -> (&str, Option<&str>) {
    let Some(rest) = text.strip_prefix('[') else {
        return (text, None);
    };
    let Some(colon) = rest.find(':') else {
        return (text, None);
    };
    let (provider, after) = rest.split_at(colon);
    if provider.is_empty()
        || !provider
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return (text, None);
    }
    let after = &after[1..];
    let Some(close) = after.find(']') else {
        return (text, None);
    };
    let (code, tail) = after.split_at(close);
    if code.is_empty() || !code.chars().all(|c| c.is_ascii_lowercase() || c == '_') {
        return (text, None);
    }
    (code, Some(tail[1..].trim_start()))
}

/// The title a failure code shows when it has none.
fn title(code: &str, provider: &str) -> String {
    let signed_in = if provider == "claude" {
        "Claude Code"
    } else if provider == "codex" {
        "Codex"
    } else {
        provider
    };
    match code {
        "auth" | "authentication_failed" => format!("Not signed in to {signed_in}"),
        "quota" | "model_quota" | "usage_limit" | "rate_limit" | "billing_error" => {
            "Usage limit reached".to_owned()
        }
        "network" => "Network trouble".to_owned(),
        "process_exit" => "Agent process exited".to_owned(),
        "context_length" => "Conversation is too long".to_owned(),
        "model_not_found" | "unrecognized_model" => "Model not recognised".to_owned(),
        _ => "Turn failed".to_owned(),
    }
}

fn text(value: Option<&Value>) -> Option<&str> {
    match value {
        Some(Value::String(text)) => Some(text.as_str()),
        _ => None,
    }
}

fn object_field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value {
        Value::Object(map) => map.get(name),
        _ => None,
    }
}

/// `structuredError`: the readable copy, the code and title, keeping the native detail.
pub fn structured_error(error: Value, provider: &str, selected_model: Option<&str>) -> Value {
    let details = object_field(&error, "details");
    let model = text(details.and_then(|details| object_field(details, "model")))
        .or(selected_model)
        .map(str::to_owned);
    let reason = text(details.and_then(|details| object_field(details, "code")))
        .or_else(|| text(object_field(&error, "code")))
        .or_else(|| text(object_field(&error, "message")))
        .unwrap_or("")
        .to_owned();
    let readable = readable(provider, &reason, model.as_deref());
    let native_message = text(object_field(&error, "message")).map(str::to_owned);
    let mut error = error;
    if let Some(readable) = &readable {
        let detail = text(object_field(&error, "detail"))
            .map(str::to_owned)
            .or_else(|| native_message.clone());
        if let Value::Object(map) = &mut error {
            map.insert("message", Value::from(readable.text.as_str()));
            let mut shaped = ace_json::Map::new();
            shaped.insert("code", Value::from(readable.code.as_str()));
            shaped.insert("provider", Value::from(provider));
            if let Some(model) = &readable.model {
                shaped.insert("model", Value::from(model.as_str()));
            }
            map.insert("details", Value::Object(shaped));
            if let Some(detail) = detail {
                map.insert("detail", Value::from(detail.as_str()));
            }
        }
    }
    let code = text(object_field(&error, "code"))
        .or_else(|| {
            text(object_field(&error, "details").and_then(|details| object_field(details, "code")))
        })
        .or_else(|| text(object_field(&error, "kind")))
        .unwrap_or("")
        .to_owned();
    let title = if object_field(&error, "title").is_some() {
        None
    } else {
        Some(title(&code, provider))
    };
    let detail = object_field(&error, "detail").is_none().then(|| {
        text(object_field(&error, "message"))
            .map(str::to_owned)
            .unwrap_or_default()
    });
    if let Value::Object(map) = &mut error {
        if let Some(title) = title {
            map.insert("title", Value::from(title.as_str()));
        }
        if let Some(detail) = detail
            && !detail.is_empty()
        {
            map.insert("detail", Value::from(detail.as_str()));
        }
        map.insert("code", Value::from(code.as_str()));
    }
    error
}

/// `shapeProviderError`: a turn's error, an error notice, or a process exit, in one shape.
pub fn shape_provider_error(fact: Value, provider: &str, selected_model: Option<&str>) -> Value {
    let kind = text(object_field(&fact, "type")).unwrap_or("").to_owned();
    if kind == "turn.ended"
        && let Some(error) = object_field(&fact, "error").cloned()
    {
        let shaped = structured_error(error, provider, selected_model);
        let mut fact = fact;
        if let Value::Object(map) = &mut fact {
            map.insert("error", shaped);
        }
        return fact;
    }
    if kind == "item.upsert" || kind == "item.reconciled" {
        let Some(Value::Object(mut draft)) = object_field(&fact, "draft").cloned() else {
            return fact;
        };
        if text(draft.get("type")) != Some("notice") {
            return fact;
        }
        let native = text(draft.get("text")).unwrap_or("Turn failed").to_owned();
        let reason = text(
            draft
                .get("details")
                .and_then(|details| object_field(details, "code")),
        )
        .or_else(|| text(draft.get("code")))
        .map(str::to_owned)
        .unwrap_or_else(|| native.clone());
        let model = text(
            draft
                .get("details")
                .and_then(|details| object_field(details, "model")),
        )
        .or(selected_model)
        .map(str::to_owned);
        let translated = readable(provider, &reason, model.as_deref());
        let is_error = text(draft.get("level")) == Some("error");
        if !is_error && translated.is_none() {
            return fact;
        }
        let mut error = ace_json::Map::new();
        error.insert("kind", Value::from("provider"));
        error.insert(
            "message",
            Value::from(
                translated
                    .as_ref()
                    .map(|translated| translated.text.as_str())
                    .unwrap_or(&native),
            ),
        );
        let code = draft
            .get("code")
            .and_then(|code| text(Some(code)))
            .map(str::to_owned)
            .or_else(|| {
                translated
                    .as_ref()
                    .map(|translated| translated.code.clone())
            });
        if let Some(code) = code {
            error.insert("code", Value::from(code.as_str()));
        }
        if let Some(value) = draft.get("title") {
            error.insert("title", value.clone());
        }
        error.insert(
            "detail",
            Value::from(
                text(draft.get("detail"))
                    .map(str::to_owned)
                    .unwrap_or_else(|| native.clone())
                    .as_str(),
            ),
        );
        // `translated?.details ?? fact.draft.details`: the readable copy's own details replace
        // the native ones, so the model the tag named survives the second shaping.
        let details = match &translated {
            Some(translated) => {
                let mut details = ace_json::Map::new();
                details.insert("code", Value::from(translated.code.as_str()));
                details.insert("provider", Value::from(provider));
                if let Some(model) = &translated.model {
                    details.insert("model", Value::from(model.as_str()));
                }
                Some(Value::Object(details))
            }
            None => draft.get("details").cloned(),
        };
        if let Some(details) = details {
            error.insert("details", details);
        }
        let shaped = structured_error(Value::Object(error), provider, selected_model);
        if let Some(message) = object_field(&shaped, "message") {
            draft.insert("text", message.clone());
        }
        for field in ["code", "title", "detail", "details"] {
            if let Some(value) = object_field(&shaped, field) {
                draft.insert(field, value.clone());
            }
        }
        let raw_empty = draft
            .get("raw")
            .is_none_or(|raw| matches!(raw, Value::Array(items) if items.is_empty()));
        if translated.is_some() && raw_empty {
            draft.insert(
                "raw",
                ace_json::json!([{"type": "provider.error", "data": {"text": native}}]),
            );
        }
        let mut fact = fact;
        if let Value::Object(map) = &mut fact {
            map.insert("draft", Value::Object(draft));
        }
        return fact;
    }
    if kind == "process.exited"
        && let Some(message) = text(object_field(&fact, "message")).map(str::to_owned)
        && let Some(readable) = readable(provider, &message, selected_model)
    {
        let mut fact = fact;
        if let Value::Object(map) = &mut fact {
            map.insert("message", Value::from(readable.text.as_str()));
        }
        return fact;
    }
    fact
}
