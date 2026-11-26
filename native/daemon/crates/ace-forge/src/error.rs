// SPDX-License-Identifier: Apache-2.0
//! The crate's typed errors, mapped by the binding to the TypeScript `ForgeError`.

/// What a forge operation reports when it fails or defers to TypeScript.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum Error {
    /// The native part is not ported yet; the shell runs the TypeScript path
    /// and counts the fallback. Never a failure, never partial.
    #[error("ace-forge {part} is not ported yet; deferred to TypeScript ({op})")]
    Unimplemented { part: String, op: String },
    /// Something the binding cannot carry; thrown as `ForgeError("cli")`, never deferred.
    #[error("ace-forge internal failure: {0}")]
    Internal(String),
}

impl Error {
    /// The F0 deferral for `op` of `part`.
    pub fn unimplemented(part: &str, op: &str) -> Self {
        Self::Unimplemented {
            part: part.to_owned(),
            op: op.to_owned(),
        }
    }

    /// True while the shell must defer to TypeScript instead of failing.
    pub fn is_stub(&self) -> bool {
        matches!(self, Self::Unimplemented { .. })
    }

    /// The `ForgeError` kind the shell throws for this error. A native failure is `cli` until a
    /// work item maps its own kinds; the shell reads the rest of the payload for `retryAt`.
    pub fn kind(&self) -> &'static str {
        "cli"
    }

    /// The `forge_error:{...}` payload the binding throws; the shell parses it back into a
    /// `ForgeError`, so `instanceof` holds. `details` is JSON text built here, so a part or
    /// message holding a quote survives.
    pub fn to_payload(&self) -> String {
        let details = match self {
            Self::Unimplemented { part, op } => format!(
                "{{\"stub\":true,\"part\":{part},\"op\":{op}}}",
                part = json_text(part),
                op = json_text(op)
            ),
            Self::Internal(message) => {
                format!("{{\"stub\":false,\"message\":{}}}", json_text(message))
            }
        };
        format!(
            "{{\"kind\":\"{}\",\"retryAt\":null,\"dispatched\":null,\"details\":{details}}}",
            self.kind()
        )
    }
}

/// `text` as a JSON string with `JSON.stringify`'s escaping, so a message can never break the
/// payload the shell parses.
fn json_text(text: &str) -> String {
    ace_json::ser::to_string(text).unwrap_or_else(|_| String::from("\"\""))
}
