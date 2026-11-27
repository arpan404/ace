// SPDX-License-Identifier: Apache-2.0
//! The MCP catalog (M1): every tool's descriptor, the public error catalog, the server
//! instructions, guide topics, session guidance, control hints and listing headers, written
//! once by `scripts/export-catalog.ts` from today's TypeScript into `native/daemon/catalog/`.
//! Both backends read these files; `scripts/export-catalog.ts --check` holds them to the
//! TypeScript's output.
//!
//! Parsed with `ace-json`, so a value reads as JavaScript reads it. Each file is parsed once,
//! on first use.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use ace_json::Value;

const TOOLS_JSON: &str = include_str!("../../../catalog/tools.json");
const ERRORS_JSON: &str = include_str!("../../../catalog/errors.json");
const INSTRUCTIONS_JSON: &str = include_str!("../../../catalog/instructions.json");
const CONTROL_HINTS_JSON: &str = include_str!("../../../catalog/control-hints.json");
const SESSION_GUIDANCE_JSON: &str = include_str!("../../../catalog/session-guidance.json");
const LISTING_HEADERS_JSON: &str = include_str!("../../../catalog/listing-headers.json");

/// Why the embedded catalog isn't the shape this crate reads. The files are generated and
/// checked, so a failure here is a bug in the export, never a fact about a device or a client.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CatalogError {
    #[error("the MCP catalog's {file} is not valid JSON: {reason}")]
    Invalid { file: &'static str, reason: String },
    #[error("the MCP catalog's {file} has no {key}")]
    Missing {
        file: &'static str,
        key: &'static str,
    },
    #[error("the MCP catalog's {file} has a {key} that isn't a {kind}")]
    WrongType {
        file: &'static str,
        key: &'static str,
        kind: &'static str,
    },
}

impl CatalogError {
    fn invalid(file: &'static str, reason: String) -> Self {
        Self::Invalid { file, reason }
    }

    fn missing(file: &'static str, key: &'static str) -> Self {
        Self::Missing { file, key }
    }

    fn wrong_type(file: &'static str, key: &'static str, kind: &'static str) -> Self {
        Self::WrongType { file, key, kind }
    }
}

/// One tool's descriptor, as the catalog writes it.
#[derive(Debug, Clone, PartialEq)]
pub struct Tool {
    pub name: String,
    pub title: String,
    pub toolset: Option<String>,
    pub risk_class: String,
    pub open_world: Option<bool>,
    pub description: String,
    pub capability: Option<String>,
    pub timeout_ms: Option<f64>,
    /// The advertised input schema, a model reads this.
    pub input: Value,
    /// The advertised output schema, when the tool declares one.
    pub output: Option<Value>,
}

/// A public error's fixed words: what happened, and the next step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErrorWords {
    pub message: String,
    pub hint: String,
}

/// The server instructions and the topics they name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Instructions {
    pub guide_topics: Vec<String>,
    pub tool_families: Vec<String>,
    pub instructions: String,
}

/// The fixed next step for an agent-control failure, by code and by operation.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ControlHints {
    pub by_code: BTreeMap<String, String>,
    pub by_op: BTreeMap<String, BTreeMap<String, String>>,
}

impl ControlHints {
    /// The next step for `op` failing with `code`: the operation's own where it has one, else
    /// the code's.
    pub fn hint(&self, op: &str, code: &str) -> Option<&str> {
        self.by_op
            .get(op)
            .and_then(|codes| codes.get(code))
            .or_else(|| self.by_code.get(code))
            .map(String::as_str)
    }
}

/// What a provider's own channel is told, and the banner a native folder trust problem needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionGuidance {
    pub listing: String,
    pub developer: String,
}

/// One listing header's name and value, as the server sends it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header {
    pub name: String,
    pub value: String,
}

/// The headers that choose a listing and name a client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListingHeaders {
    pub core: Header,
    pub static_listing: Header,
    pub codex: Header,
    pub cursor: Header,
}

/// The whole catalog, parsed once.
#[derive(Debug, Clone, PartialEq)]
pub struct Catalog {
    pub tools: Vec<Tool>,
    pub error_codes: Vec<String>,
    pub errors: BTreeMap<String, ErrorWords>,
    /// The setting each device permission needs, by permission name.
    pub permission_hints: BTreeMap<String, String>,
    /// The words a failure renders when the catalog has no entry for its code.
    pub fallbacks: ErrorWords,
    pub instructions: Instructions,
    pub control_hints: ControlHints,
    pub session_guidance: BTreeMap<String, SessionGuidance>,
    pub gemini_untrusted: String,
    pub listing_headers: ListingHeaders,
}

static CATALOG: OnceLock<Result<Catalog, CatalogError>> = OnceLock::new();

/// The catalog both backends serve, parsed on first use.
pub fn catalog() -> Result<&'static Catalog, CatalogError> {
    CATALOG
        .get_or_init(|| {
            Ok(Catalog {
                tools: parse_tools(TOOLS_JSON)?,
                error_codes: parse_error_codes(ERRORS_JSON)?,
                errors: parse_errors(ERRORS_JSON)?,
                permission_hints: parse_permission_hints(ERRORS_JSON)?,
                fallbacks: parse_error_fallbacks(ERRORS_JSON)?,
                instructions: parse_instructions(INSTRUCTIONS_JSON)?,
                control_hints: parse_control_hints(CONTROL_HINTS_JSON)?,
                session_guidance: parse_session_guidance(SESSION_GUIDANCE_JSON)?,
                gemini_untrusted: parse_gemini_untrusted(SESSION_GUIDANCE_JSON)?,
                listing_headers: parse_listing_headers(LISTING_HEADERS_JSON)?,
            })
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn parse(file: &'static str, raw: &str) -> Result<Value, CatalogError> {
    ace_json::parse(raw).map_err(|error| CatalogError::invalid(file, error.to_string()))
}

fn object<'a>(
    file: &'static str,
    key: &'static str,
    value: &'a Value,
) -> Result<&'a ace_json::Map, CatalogError> {
    value
        .as_object()
        .ok_or_else(|| CatalogError::wrong_type(file, key, "object"))
}

fn array<'a>(
    file: &'static str,
    key: &'static str,
    value: &'a Value,
) -> Result<&'a ace_json::Array, CatalogError> {
    value
        .as_array()
        .ok_or_else(|| CatalogError::wrong_type(file, key, "array"))
}

fn text(file: &'static str, key: &'static str, value: &Value) -> Result<String, CatalogError> {
    value
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| CatalogError::wrong_type(file, key, "string"))
}

fn field<'a>(
    file: &'static str,
    key: &'static str,
    object: &'a ace_json::Map,
) -> Result<&'a Value, CatalogError> {
    object
        .get(key)
        .ok_or_else(|| CatalogError::missing(file, key))
}

fn optional_text(key: &'static str, object: &ace_json::Map) -> Option<String> {
    object.get(key).and_then(Value::as_str).map(str::to_string)
}

fn optional_number(key: &'static str, object: &ace_json::Map) -> Option<f64> {
    object.get(key).and_then(Value::as_f64)
}

fn string_list(
    file: &'static str,
    key: &'static str,
    value: &Value,
) -> Result<Vec<String>, CatalogError> {
    array(file, key, value)?
        .iter()
        .map(|item| text(file, key, item))
        .collect()
}

fn parse_tools(raw: &str) -> Result<Vec<Tool>, CatalogError> {
    const FILE: &str = "tools.json";
    let parsed = parse(FILE, raw)?;
    let root = object(FILE, "root", &parsed)?;
    let listed = array(FILE, "tools", field(FILE, "tools", root)?)?;
    listed
        .iter()
        .map(|entry| {
            let tool = object(FILE, "tool", entry)?;
            Ok(Tool {
                name: text(FILE, "name", field(FILE, "name", tool)?)?,
                title: text(FILE, "title", field(FILE, "title", tool)?)?,
                toolset: optional_text("toolset", tool),
                risk_class: text(FILE, "riskClass", field(FILE, "riskClass", tool)?)?,
                open_world: tool.get("openWorld").and_then(Value::as_bool),
                description: text(FILE, "description", field(FILE, "description", tool)?)?,
                capability: optional_text("capability", tool),
                timeout_ms: optional_number("timeoutMs", tool),
                input: field(FILE, "input", tool)?.clone(),
                output: tool.get("output").cloned(),
            })
        })
        .collect()
}

fn parse_error_codes(raw: &str) -> Result<Vec<String>, CatalogError> {
    const FILE: &str = "errors.json";
    let parsed = parse(FILE, raw)?;
    let root = object(FILE, "root", &parsed)?;
    string_list(FILE, "codes", field(FILE, "codes", root)?)
}

fn parse_errors(raw: &str) -> Result<BTreeMap<String, ErrorWords>, CatalogError> {
    const FILE: &str = "errors.json";
    let parsed = parse(FILE, raw)?;
    let root = object(FILE, "root", &parsed)?;
    let catalog = object(FILE, "catalog", field(FILE, "catalog", root)?)?;
    catalog
        .iter()
        .map(|(code, words)| {
            let entry = object(FILE, "error", words)?;
            Ok((
                code.as_str().to_string(),
                ErrorWords {
                    message: text(FILE, "message", field(FILE, "message", entry)?)?,
                    hint: text(FILE, "hint", field(FILE, "hint", entry)?)?,
                },
            ))
        })
        .collect()
}

fn parse_permission_hints(raw: &str) -> Result<BTreeMap<String, String>, CatalogError> {
    const FILE: &str = "errors.json";
    let parsed = parse(FILE, raw)?;
    let root = object(FILE, "root", &parsed)?;
    let hints = object(
        FILE,
        "permissionHints",
        field(FILE, "permissionHints", root)?,
    )?;
    hints
        .iter()
        .map(|(permission, hint)| {
            Ok((
                permission.as_str().to_string(),
                text(FILE, "permissionHints", hint)?,
            ))
        })
        .collect()
}

fn parse_error_fallbacks(raw: &str) -> Result<ErrorWords, CatalogError> {
    const FILE: &str = "errors.json";
    let parsed = parse(FILE, raw)?;
    let root = object(FILE, "root", &parsed)?;
    let fallbacks = object(FILE, "fallbacks", field(FILE, "fallbacks", root)?)?;
    let missing = object(FILE, "missing", field(FILE, "missing", fallbacks)?)?;
    Ok(ErrorWords {
        message: text(FILE, "message", field(FILE, "message", missing)?)?,
        hint: text(FILE, "hint", field(FILE, "hint", missing)?)?,
    })
}

fn parse_instructions(raw: &str) -> Result<Instructions, CatalogError> {
    const FILE: &str = "instructions.json";
    let parsed = parse(FILE, raw)?;
    let root = object(FILE, "root", &parsed)?;
    Ok(Instructions {
        guide_topics: string_list(FILE, "guideTopics", field(FILE, "guideTopics", root)?)?,
        tool_families: string_list(FILE, "toolFamilies", field(FILE, "toolFamilies", root)?)?,
        instructions: text(FILE, "instructions", field(FILE, "instructions", root)?)?,
    })
}

fn parse_control_hints(raw: &str) -> Result<ControlHints, CatalogError> {
    const FILE: &str = "control-hints.json";
    let parsed = parse(FILE, raw)?;
    let root = object(FILE, "root", &parsed)?;
    let by_code = object(FILE, "byCode", field(FILE, "byCode", root)?)?
        .iter()
        .map(|(code, hint)| Ok((code.as_str().to_string(), text(FILE, "byCode", hint)?)))
        .collect::<Result<BTreeMap<String, String>, CatalogError>>()?;
    let by_op = object(FILE, "byOp", field(FILE, "byOp", root)?)?
        .iter()
        .map(|(op, codes)| {
            let codes = object(FILE, "byOp", codes)?
                .iter()
                .map(|(code, hint)| Ok((code.as_str().to_string(), text(FILE, "byOp", hint)?)))
                .collect::<Result<BTreeMap<String, String>, CatalogError>>()?;
            Ok((op.as_str().to_string(), codes))
        })
        .collect::<Result<BTreeMap<String, BTreeMap<String, String>>, CatalogError>>()?;
    Ok(ControlHints { by_code, by_op })
}

fn parse_session_guidance(raw: &str) -> Result<BTreeMap<String, SessionGuidance>, CatalogError> {
    const FILE: &str = "session-guidance.json";
    let parsed = parse(FILE, raw)?;
    let root = object(FILE, "root", &parsed)?;
    let providers = object(FILE, "providers", field(FILE, "providers", root)?)?;
    providers
        .iter()
        .map(|(provider, guidance)| {
            let guidance = object(FILE, "guidance", guidance)?;
            Ok((
                provider.as_str().to_string(),
                SessionGuidance {
                    listing: text(FILE, "listing", field(FILE, "listing", guidance)?)?,
                    developer: text(FILE, "developer", field(FILE, "developer", guidance)?)?,
                },
            ))
        })
        .collect()
}

fn parse_gemini_untrusted(raw: &str) -> Result<String, CatalogError> {
    const FILE: &str = "session-guidance.json";
    let parsed = parse(FILE, raw)?;
    let root = object(FILE, "root", &parsed)?;
    text(
        FILE,
        "geminiUntrusted",
        field(FILE, "geminiUntrusted", root)?,
    )
}

fn parse_listing_headers(raw: &str) -> Result<ListingHeaders, CatalogError> {
    const FILE: &str = "listing-headers.json";
    let parsed = parse(FILE, raw)?;
    let root = object(FILE, "root", &parsed)?;
    let header = |key: &'static str, value: &Value| -> Result<Header, CatalogError> {
        let entry = object(FILE, key, value)?;
        Ok(Header {
            name: text(FILE, "name", field(FILE, "name", entry)?)?,
            value: text(FILE, "value", field(FILE, "value", entry)?)?,
        })
    };
    let clients = object(FILE, "clients", field(FILE, "clients", root)?)?;
    Ok(ListingHeaders {
        core: header("core", field(FILE, "core", root)?)?,
        static_listing: header("static", field(FILE, "static", root)?)?,
        codex: header("codex", field(FILE, "codex", clients)?)?,
        cursor: header("cursor", field(FILE, "cursor", clients)?)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_embedded_catalog_parses_into_every_part() {
        let catalog = catalog().expect("the embedded catalog parses");
        assert!(catalog.tools.len() > 20, "{} tools", catalog.tools.len());
        assert!(!catalog.instructions.instructions.is_empty());
        assert!(!catalog.instructions.guide_topics.is_empty());
        assert!(!catalog.error_codes.is_empty());
        assert!(!catalog.errors.is_empty());
        assert!(!catalog.permission_hints.is_empty());
        assert!(!catalog.fallbacks.message.is_empty());
        assert!(!catalog.session_guidance.is_empty());
    }

    #[test]
    fn a_tool_is_found_by_the_name_a_model_calls_and_only_once() {
        let catalog = catalog().expect("the embedded catalog parses");
        let names: Vec<&str> = catalog
            .tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect();
        let mut sorted = names.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(names.len(), sorted.len(), "a tool is described twice");
        let notify = catalog
            .tools
            .iter()
            .find(|tool| tool.name == "notify")
            .expect("notify is in the catalog");
        assert_eq!(notify.toolset.as_deref(), Some("ace-threads"));
        assert!(!notify.description.is_empty());
        // The advertised schema is an object a client can send.
        assert_eq!(
            notify
                .input
                .as_object()
                .and_then(|root| root.get("type"))
                .and_then(Value::as_str),
            Some("object")
        );
        assert!(catalog.tools.iter().all(|tool| !tool.title.is_empty()));
    }

    #[test]
    fn every_public_error_code_has_its_words() {
        let catalog = catalog().expect("the embedded catalog parses");
        for code in &catalog.error_codes {
            let words = catalog.errors.get(code).expect("every code has words");
            assert!(!words.message.is_empty(), "{code}");
            assert!(!words.hint.is_empty(), "{code}");
        }
        assert_eq!(catalog.error_codes.len(), catalog.errors.len());
    }

    #[test]
    fn a_control_hint_prefers_the_operations_own_step_over_the_codes() {
        let hints = &catalog()
            .expect("the embedded catalog parses")
            .control_hints;
        let generic = hints
            .by_code
            .get("limit")
            .cloned()
            .expect("a general limit step");
        assert_eq!(hints.hint("thread.rename", "limit"), Some(generic.as_str()));
        let own = hints
            .hint("thread.rename", "not_ready")
            .expect("the rename step");
        assert!(own.contains("provisional"), "{own}");
        assert_eq!(hints.hint("thread.rename", "no_such_code"), None);
    }

    #[test]
    fn every_provider_has_its_own_guidance_and_listing() {
        let catalog = catalog().expect("the embedded catalog parses");
        for provider in [
            "claude",
            "codex",
            "opencode",
            "cursor",
            "antigravity",
            "acp",
            "pi",
        ] {
            let guidance = catalog
                .session_guidance
                .get(provider)
                .unwrap_or_else(|| panic!("{provider} has guidance"));
            assert!(!guidance.developer.is_empty(), "{provider}");
            assert!(
                matches!(guidance.listing.as_str(), "all" | "core" | "static"),
                "{provider}: {}",
                guidance.listing
            );
        }
        assert!(catalog.gemini_untrusted.contains("does not trust"));
    }

    #[test]
    fn the_listing_headers_are_the_ones_a_client_sends() {
        let headers = &catalog()
            .expect("the embedded catalog parses")
            .listing_headers;
        assert_eq!(headers.core.name, "X-Ace-Tools");
        assert_eq!(headers.core.value, "core");
        assert_eq!(headers.static_listing.value, "static");
        assert_eq!(headers.codex.name, "X-Ace-Client");
        assert_eq!(headers.codex.value, "codex");
        assert_eq!(headers.cursor.value, "cursor");
    }
}
