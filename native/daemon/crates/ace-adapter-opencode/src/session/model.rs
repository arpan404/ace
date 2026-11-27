// SPDX-License-Identifier: Apache-2.0
//! The input shapes the session builds (`packages/adapter-opencode/src/input.ts`):
//! the model object every create, model switch and prompt sends, and the prompt
//! message id.
//!
//! **Effort levels (#2802, 2026-11-26).** `variant` is the chosen effort's id,
//! taken from the catalog's `variants[].id` (`packages/models/src/open-code.ts:92`),
//! never from `settings.reasoningEffort`. The object is exactly
//! `{providerID, id, variant}`, and `variant` is present only when the effort is
//! a string (`input.ts:8`-`:22`).

use ace_json::{Map, Value, json};

/// Why a model string could not be read. The TypeScript throws this text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ModelError {
    #[error("OpenCode model must be provider/model")]
    Shape,
}

/// `selectedModel(model, options)`: the first `/` splits the provider from the
/// id, so an id may hold more slashes; the effort, when it is a string, is the
/// variant.
pub fn selected_model(
    model: Option<&str>,
    effort: Option<&Value>,
) -> Result<Option<Value>, ModelError> {
    let Some(model) = model else {
        return Ok(None);
    };
    let Some(slash) = model.find('/') else {
        return Err(ModelError::Shape);
    };
    if slash == 0 || slash == model.len() - 1 {
        return Err(ModelError::Shape);
    }
    let mut value = Map::new();
    value.insert("providerID".to_owned(), json!(&model[..slash]));
    value.insert("id".to_owned(), json!(&model[slash + 1..]));
    if let Some(Value::String(variant)) = effort {
        value.insert("variant".to_owned(), json!(variant.as_str()));
    }
    Ok(Some(Value::Object(value)))
}

/// `messageId(now, sequence, entropy)`: `msg_` and the low 48 bits of
/// `(now << 12) + sequence % 4096` in twelve hex digits, then the entropy.
pub fn message_id(now: u64, sequence: u64, entropy: &str) -> String {
    let prefix = ((u128::from(now) << 12) + u128::from(sequence % 4096)) & 0xffff_ffff_ffff;
    format!("msg_{prefix:012x}{entropy}")
}

#[cfg(test)]
mod tests;
