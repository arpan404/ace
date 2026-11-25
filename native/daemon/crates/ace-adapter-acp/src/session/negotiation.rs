// SPDX-License-Identifier: Apache-2.0
//! ACP initialize negotiation and bridge extensions
//! (`packages/adapter-acp/src/{negotiation,bridge-negotiation}.ts`,
//! `packages/agent-registry/src/profiles.ts`).

use std::cmp::Ordering;

use ace_json::{Map, Value};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::mcp::McpTransport;
use super::protocol::PROTOCOL_VERSION;
use super::quirks::{AcpSessionQuirks, CliVersion, compare_cli_versions, parse_cli_version};
use crate::translate::data::object;

/// How a profile covers a version (`profiles.ts:133`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileFit {
    Verified,
    Compatible,
}

/// Optional upper-bound range on a compatibility profile (`profiles.ts:14`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompatibleRange {
    pub below: String,
}

/// Compatibility profile metadata used during negotiation and selector decoding
/// (`profiles.ts:3`–`:26`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatibilityProfile {
    pub id: String,
    pub agent: String,
    pub version: String,
    #[serde(default)]
    pub compatible: Option<CompatibleRange>,
    #[serde(default)]
    pub legacy_model: bool,
    #[serde(default)]
    pub deny_selectors: bool,
    #[serde(default)]
    pub deny_resume: bool,
    #[serde(default)]
    pub deny_http_mcp: bool,
    #[serde(default)]
    pub subagent_sessions: bool,
}

/// Whether `version` is in `profile`'s range (`profiles.ts:140`–`:151`).
pub fn profile_fit(profile: &CompatibilityProfile, version: &str) -> Option<ProfileFit> {
    if version == profile.version {
        return Some(ProfileFit::Verified);
    }
    let reported = parse_cli_version(version)?;
    let verified = parse_cli_version(&profile.version)?;
    if compare_cli_versions(&reported, &verified) == Ordering::Less {
        return None;
    }
    let ceiling = match &profile.compatible {
        Some(range) => parse_cli_version(&range.below)?,
        None => CliVersion {
            major: verified.major.saturating_add(1),
            minor: 0,
            patch: 0,
            prerelease: vec!["0".to_owned()],
        },
    };
    if compare_cli_versions(&reported, &ceiling) != Ordering::Less {
        return None;
    }
    if compare_cli_versions(&reported, &verified) == Ordering::Equal {
        Some(ProfileFit::Verified)
    } else {
        Some(ProfileFit::Compatible)
    }
}

/// Opt into only the reviewed child-session contract; no AIR background/auth extensions
/// (`bridge-negotiation.ts:8`–`:14`).
pub fn client_meta(meta: &Map, profile: Option<&CompatibilityProfile>) -> Map {
    let mut out = meta.clone();
    if profile.is_some_and(|p| p.subagent_sessions) {
        let mut air = Map::with_capacity(2);
        air.insert("version", Value::from(1u64));
        air.insert(
            "capabilities",
            Value::Array(vec![Value::from("nativeSubagentSessions")].into()),
        );
        let mut jetbrains = Map::with_capacity(1);
        jetbrains.insert("air", Value::Object(air));
        out.insert("jetbrains", Value::Object(jetbrains));
    }
    out
}

/// Draft fields remain raw and malformed extension claims disable support rather than
/// closing ACP (`bridge-negotiation.ts:16`–`:27`).
pub fn bridge_subagents(raw: &Value, profile: Option<&CompatibilityProfile>) -> bool {
    if !profile.is_some_and(|p| p.subagent_sessions) {
        return false;
    }
    let Some(response) = raw.as_object() else {
        return false;
    };
    if let Some(capabilities) = response.get("agentCapabilities").and_then(Value::as_object)
        && let Some(sessions) = capabilities
            .get("sessionCapabilities")
            .and_then(Value::as_object)
        && let Some(subagents) = sessions.get("subagents")
    {
        return subagents.is_object();
    }
    let Some(meta) = response.get("_meta").and_then(Value::as_object) else {
        return false;
    };
    let Some(jetbrains) = meta.get("jetbrains").and_then(Value::as_object) else {
        return false;
    };
    let Some(air) = jetbrains.get("air").and_then(Value::as_object) else {
        return false;
    };
    let valid_version = air
        .get("version")
        .and_then(Value::as_f64)
        .is_some_and(|v| v.is_finite() && v.fract() == 0.0 && v >= 1.0);
    if !valid_version {
        return false;
    }
    let Some(caps) = air.get("capabilities").and_then(Value::as_array) else {
        return false;
    };
    if caps.len() > 128 {
        return false;
    }
    let mut has_native = false;
    for cap in caps {
        let Some(text) = cap.as_js_str() else {
            return false;
        };
        if text.len_utf16() > 128 {
            return false;
        }
        if text.as_str() == "nativeSubagentSessions" {
            has_native = true;
        }
    }
    has_native
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ResumeMethod {
    #[serde(rename = "session/resume")]
    SessionResume,
    #[serde(rename = "session/load")]
    SessionLoad,
}

impl ResumeMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            ResumeMethod::SessionResume => "session/resume",
            ResumeMethod::SessionLoad => "session/load",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunsAs {
    Profile,
    Generic,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionChanged {
    pub approved: String,
    pub reported: String,
    pub runs_as: RunsAs,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum NegotiationError {
    #[error("Invalid ACP initialize response: {0}")]
    InvalidInitialize(String),
    #[error("Unexpected Antigravity ACP identity")]
    UnexpectedAntigravityIdentity,
}

/// Result of `initialize` negotiation (`negotiation.ts:36`–`:58`).
#[derive(Debug, Clone, PartialEq)]
pub struct Negotiated {
    pub capabilities: Map,
    pub system_prompt_append: bool,
    pub http_mcp: bool,
    pub sse_mcp: bool,
    pub subagent_sessions: bool,
    pub resume_method: Option<ResumeMethod>,
    pub profile: Option<CompatibilityProfile>,
    pub profile_fit: Option<ProfileFit>,
    pub version_changed: Option<VersionChanged>,
    pub raw: Value,
}

fn validate_opt_bool(map: &Map, field: &str) -> Result<Option<bool>, NegotiationError> {
    match map.get(field) {
        None => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(NegotiationError::InvalidInitialize(format!(
            "expected boolean for {field}"
        ))),
    }
}

/// Negotiate session capabilities from an `initialize` reply (`negotiation.ts:59`–`:127`).
pub fn negotiate(
    raw: &Value,
    quirks: &AcpSessionQuirks,
    version: Option<&str>,
    profile: Option<&CompatibilityProfile>,
    approved_fit: Option<ProfileFit>,
) -> Result<Negotiated, NegotiationError> {
    let Some(root) = raw.as_object() else {
        return Err(NegotiationError::InvalidInitialize(
            "initialize result must be an object".to_owned(),
        ));
    };
    let protocol_ok = root
        .get("protocolVersion")
        .and_then(Value::as_f64)
        .is_some_and(|v| v == PROTOCOL_VERSION as f64);
    if !protocol_ok {
        return Err(NegotiationError::InvalidInitialize(
            "protocolVersion must be 1".to_owned(),
        ));
    }

    let (agent_name, reported_version): (Option<String>, Option<String>) =
        match root.get("agentInfo") {
            None => (None, None),
            Some(Value::Object(info)) => {
                let Some(name) = info.get("name").and_then(Value::as_str) else {
                    return Err(NegotiationError::InvalidInitialize(
                        "agentInfo.name must be a string".to_owned(),
                    ));
                };
                let ver = match info.get("version") {
                    None => None,
                    Some(Value::String(s)) => Some(s.to_string()),
                    Some(_) => {
                        return Err(NegotiationError::InvalidInitialize(
                            "agentInfo.version must be a string".to_owned(),
                        ));
                    }
                };
                (Some(name.to_owned()), ver)
            }
            Some(_) => {
                return Err(NegotiationError::InvalidInitialize(
                    "agentInfo must be an object".to_owned(),
                ));
            }
        };

    if quirks.provider() == "antigravity" && agent_name.as_deref() != Some("antigravity-acp") {
        return Err(NegotiationError::UnexpectedAntigravityIdentity);
    }

    let empty_map = Map::new();
    let advertised = match root.get("agentCapabilities") {
        None => &empty_map,
        Some(Value::Object(caps)) => caps,
        Some(_) => {
            return Err(NegotiationError::InvalidInitialize(
                "agentCapabilities must be an object".to_owned(),
            ));
        }
    };

    let load_session = validate_opt_bool(advertised, "loadSession")?.unwrap_or(false);
    let (prompt_image, prompt_embedded) = match advertised.get("promptCapabilities") {
        None => (false, false),
        Some(Value::Object(pc)) => (
            validate_opt_bool(pc, "image")?.unwrap_or(false),
            validate_opt_bool(pc, "embeddedContext")?.unwrap_or(false),
        ),
        Some(_) => {
            return Err(NegotiationError::InvalidInitialize(
                "promptCapabilities must be an object".to_owned(),
            ));
        }
    };
    let (mcp_http, mcp_sse) = match advertised.get("mcpCapabilities") {
        None => (false, false),
        Some(Value::Object(mc)) => (
            validate_opt_bool(mc, "http")?.unwrap_or(false),
            validate_opt_bool(mc, "sse")?.unwrap_or(false),
        ),
        Some(_) => {
            return Err(NegotiationError::InvalidInitialize(
                "mcpCapabilities must be an object".to_owned(),
            ));
        }
    };

    let changed = quirks.provider() == "acp"
        && version.is_some_and(|v| !v.is_empty())
        && reported_version
            .as_deref()
            .is_some_and(|r| !r.is_empty() && Some(r) != version);
    let running = if changed {
        reported_version.as_deref()
    } else {
        version.or(reported_version.as_deref())
    };

    let mut active_profile = profile.cloned();
    let mut fit: Option<ProfileFit> = None;
    if let Some(prof) = &active_profile {
        fit = approved_fit.or_else(|| match version {
            Some(v) if !v.is_empty() => profile_fit(prof, v),
            _ => Some(ProfileFit::Verified),
        });
        let judged = if changed {
            reported_version.as_deref()
        } else if version.is_some_and(|v| !v.is_empty()) {
            None
        } else {
            reported_version.as_deref()
        };
        if fit.is_some()
            && let Some(judged_ver) = judged
        {
            fit = profile_fit(prof, judged_ver).map(|_| ProfileFit::Compatible);
        }
    }
    if fit.is_none() {
        active_profile = None;
    }

    let version_changed = if changed {
        Some(VersionChanged {
            approved: version.unwrap_or("").to_owned(),
            reported: reported_version.clone().unwrap_or_default(),
            runs_as: if active_profile.is_some() {
                RunsAs::Profile
            } else {
                RunsAs::Generic
            },
        })
    } else {
        None
    };

    let mut caps = quirks.capabilities(running);
    let generic = quirks.provider() == "acp";
    let subagent_sessions = bridge_subagents(raw, active_profile.as_ref());
    let has_session_resume = advertised
        .get("sessionCapabilities")
        .is_some_and(|sc| !matches!(object(sc).get("resume"), None | Some(Value::Null)));
    let resume_method = if has_session_resume {
        Some(ResumeMethod::SessionResume)
    } else if load_session {
        Some(ResumeMethod::SessionLoad)
    } else {
        None
    };

    let deny_resume = active_profile.as_ref().is_some_and(|p| p.deny_resume);
    let deny_http_mcp = active_profile.as_ref().is_some_and(|p| p.deny_http_mcp);
    let existing_resume = caps.get("resume").and_then(Value::as_bool).unwrap_or(false);
    let existing_image = caps
        .get("imageInput")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if advertises_steering(raw) {
        caps.insert("steeringMode", Value::from("native"));
    }
    if generic {
        caps.insert("subagentTranscripts", Value::Bool(subagent_sessions));
    }
    caps.insert(
        "resume",
        Value::Bool(!deny_resume && resume_method.is_some() && (generic || existing_resume)),
    );
    caps.insert(
        "imageInput",
        Value::Bool(prompt_image && (generic || existing_image)),
    );
    let mut attachment_input = Map::with_capacity(5);
    attachment_input.insert("format", Value::from("acp"));
    attachment_input.insert(
        "documents",
        Value::Array(
            if prompt_embedded {
                vec![Value::from("*")]
            } else {
                Vec::new()
            }
            .into(),
        ),
    );
    attachment_input.insert("embeddedContext", Value::Bool(prompt_embedded));
    attachment_input.insert("interleaved", Value::Bool(true));
    attachment_input.insert("maxInlineBytes", Value::from(4u64 * 1024 * 1024));
    caps.insert("attachmentInput", Value::Object(attachment_input));
    caps.insert("planMode", Value::Bool(false));

    Ok(Negotiated {
        capabilities: caps,
        system_prompt_append: advertises_system_prompt_append(raw),
        http_mcp: !deny_http_mcp && mcp_http,
        sse_mcp: !deny_http_mcp && mcp_sse,
        subagent_sessions,
        resume_method,
        profile_fit: if active_profile.is_some() { fit } else { None },
        profile: active_profile,
        version_changed,
        raw: raw.clone(),
    })
}

fn advertises_steering(raw: &Value) -> bool {
    let meta = object(object(raw).get("_meta").unwrap_or(&Value::Null));
    let steering = object(meta.get("steering").unwrap_or(&Value::Null));
    steering.get("supported") == Some(&Value::Bool(true))
}

fn advertises_system_prompt_append(raw: &Value) -> bool {
    let caps = object(object(raw).get("agentCapabilities").unwrap_or(&Value::Null));
    let meta = object(caps.get("_meta").unwrap_or(&Value::Null));
    let agy = object(meta.get("antigravity").unwrap_or(&Value::Null));
    let sp = object(agy.get("systemPrompt").unwrap_or(&Value::Null));
    sp.get("append") == Some(&Value::Bool(true))
}

/// Bounded JSON snapshot (`negotiation.ts:142`–`:152`).
pub fn bounded_raw(value: &Value) -> Map {
    let json = value.to_json();
    let bytes = json.as_bytes();
    let truncated = bytes.len() > 2048;
    let text = if truncated {
        let lossy = String::from_utf8_lossy(&bytes[..2048]);
        lossy.strip_suffix('\u{FFFD}').unwrap_or(&lossy).to_owned()
    } else {
        json
    };
    let mut out = Map::with_capacity(2);
    out.insert("json", Value::from(text));
    out.insert("truncated", Value::Bool(truncated));
    out
}

/// Build the `AcpSessionSupport` payload (`negotiation.ts:153`–`:173`).
pub fn session_support(
    negotiated: &Negotiated,
    raw_redacted: &Value,
    has_model_selector: bool,
    has_mode_selector: bool,
    has_plan_mode: bool,
    mcp: McpTransport,
    coverage: &str,
) -> Map {
    let mut capabilities = Map::with_capacity(3);
    capabilities.insert(
        "resume",
        Value::Bool(
            negotiated
                .capabilities
                .get("resume")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    );
    capabilities.insert(
        "imageInput",
        Value::Bool(
            negotiated
                .capabilities
                .get("imageInput")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    );
    capabilities.insert("planMode", Value::Bool(has_plan_mode));

    let mut support = Map::with_capacity(8);
    support.insert("capabilities", Value::Object(capabilities));
    support.insert("mcp", Value::from(mcp.as_str()));
    support.insert("modelSelection", Value::Bool(has_model_selector));
    support.insert("modeSelection", Value::Bool(has_mode_selector));
    support.insert(
        "subagentSessions",
        Value::Bool(negotiated.subagent_sessions),
    );
    support.insert("coverage", Value::from(coverage));
    support.insert("visibility", Value::from("limited"));
    support.insert("raw", Value::Object(bounded_raw(raw_redacted)));
    support
}

#[cfg(test)]
mod tests {
    use super::{
        CompatibilityProfile, NegotiationError, ProfileFit, ResumeMethod, RunsAs, VersionChanged,
        bounded_raw, bridge_subagents, client_meta, negotiate,
    };
    use crate::session::quirks::AcpSessionQuirks;
    use ace_json::{Map, Value, json};

    fn gemini_profile() -> CompatibilityProfile {
        CompatibilityProfile {
            id: "gemini-043".to_owned(),
            agent: "gemini".to_owned(),
            version: "0.43.0".to_owned(),
            compatible: None,
            legacy_model: true,
            deny_selectors: false,
            deny_resume: false,
            deny_http_mcp: false,
            subagent_sessions: false,
        }
    }

    fn claude_bridge_profile() -> CompatibilityProfile {
        CompatibilityProfile {
            id: "claude-bridge".to_owned(),
            agent: "claude-acp".to_owned(),
            version: "0.85.1".to_owned(),
            compatible: None,
            legacy_model: true,
            deny_selectors: false,
            deny_resume: false,
            deny_http_mcp: false,
            subagent_sessions: true,
        }
    }

    #[test]
    fn agent_reporting_version_outside_or_inside_profile_range_behaves_like_ts_negotiation_test() {
        let quirks = AcpSessionQuirks::generic();
        let profile = gemini_profile();

        let outside = negotiate(
            &json!({
                "protocolVersion": 1,
                "agentInfo": { "name": "synthetic", "version": "2.0.0" },
                "agentCapabilities": { "loadSession": true }
            }),
            &quirks,
            Some("0.43.0"),
            Some(&profile),
            None,
        );
        let Ok(outside) = outside else {
            panic!("expected negotiation success");
        };
        assert_eq!(outside.profile, None);
        assert_eq!(outside.profile_fit, None);
        assert_eq!(
            outside.version_changed,
            Some(VersionChanged {
                approved: "0.43.0".to_owned(),
                reported: "2.0.0".to_owned(),
                runs_as: RunsAs::Generic,
            })
        );

        let same = negotiate(
            &json!({
                "protocolVersion": 1,
                "agentInfo": { "name": "synthetic", "version": "0.43.0" },
                "agentCapabilities": { "loadSession": true }
            }),
            &quirks,
            Some("0.43.0"),
            Some(&profile),
            None,
        );
        let Ok(same) = same else {
            panic!("expected negotiation success");
        };
        assert_eq!(same.profile, Some(profile.clone()));
        assert_eq!(same.profile_fit, Some(ProfileFit::Verified));

        let compatible = negotiate(
            &json!({
                "protocolVersion": 1,
                "agentInfo": { "name": "synthetic", "version": "0.45.2" },
                "agentCapabilities": { "loadSession": true }
            }),
            &quirks,
            Some("0.43.0"),
            Some(&profile),
            None,
        );
        let Ok(compatible) = compatible else {
            panic!("expected negotiation success");
        };
        assert_eq!(compatible.profile, Some(profile.clone()));
        assert_eq!(compatible.profile_fit, Some(ProfileFit::Compatible));
        assert_eq!(
            compatible.version_changed,
            Some(VersionChanged {
                approved: "0.43.0".to_owned(),
                reported: "0.45.2".to_owned(),
                runs_as: RunsAs::Profile,
            })
        );
    }

    #[test]
    fn versions_below_verified_never_keep_profile_and_unverified_never_becomes_verified() {
        let quirks = AcpSessionQuirks::generic();
        let claude = claude_bridge_profile();
        for reported in ["0.85.0", "0.85.1-beta.1", "1.0.0", "not a version"] {
            let Ok(negotiated) = negotiate(
                &json!({
                    "protocolVersion": 1,
                    "agentInfo": { "name": "synthetic", "version": reported }
                }),
                &quirks,
                Some("0.85.1"),
                Some(&claude),
                None,
            ) else {
                panic!("expected negotiation success for {reported}");
            };
            assert_eq!(negotiated.profile, None, "reported={reported}");
        }

        let gemini = gemini_profile();
        let Ok(still_compat) = negotiate(
            &json!({
                "protocolVersion": 1,
                "agentInfo": { "name": "synthetic", "version": "0.43.0" },
                "agentCapabilities": { "loadSession": true }
            }),
            &quirks,
            Some("0.45.0"),
            Some(&gemini),
            Some(ProfileFit::Compatible),
        ) else {
            panic!("expected negotiation success");
        };
        assert_eq!(still_compat.profile, Some(gemini.clone()));
        assert_eq!(still_compat.profile_fit, Some(ProfileFit::Compatible));

        let Ok(unchanged) = negotiate(
            &json!({
                "protocolVersion": 1,
                "agentInfo": { "name": "synthetic", "version": "0.43.0" }
            }),
            &quirks,
            Some("0.43.0"),
            Some(&gemini),
            Some(ProfileFit::Compatible),
        ) else {
            panic!("expected negotiation success");
        };
        assert_eq!(unchanged.profile_fit, Some(ProfileFit::Compatible));
    }

    #[test]
    fn antigravity_identity_steering_system_prompt_and_bridge_subagents() {
        let agy = AcpSessionQuirks::antigravity();
        let bad = negotiate(
            &json!({ "protocolVersion": 1, "agentInfo": { "name": "other" } }),
            &agy,
            Some("1.2.1"),
            None,
            None,
        );
        assert_eq!(bad, Err(NegotiationError::UnexpectedAntigravityIdentity));

        let Ok(good) = negotiate(
            &json!({
                "protocolVersion": 1,
                "agentInfo": { "name": "antigravity-acp", "version": "1.2.1" },
                "_meta": { "steering": { "supported": true } },
                "agentCapabilities": {
                    "loadSession": true,
                    "sessionCapabilities": { "resume": {} },
                    "promptCapabilities": { "image": true, "embeddedContext": true },
                    "mcpCapabilities": { "http": true, "sse": false },
                    "_meta": { "antigravity": { "systemPrompt": { "append": true } } }
                }
            }),
            &agy,
            Some("1.2.1"),
            None,
            None,
        ) else {
            panic!("expected Antigravity negotiation success");
        };
        assert_eq!(good.resume_method, Some(ResumeMethod::SessionResume));
        assert!(good.system_prompt_append);
        assert!(good.http_mcp);
        assert!(!good.sse_mcp);
        assert_eq!(
            good.capabilities
                .get("steeringMode")
                .and_then(Value::as_str),
            Some("native")
        );

        let bridge = claude_bridge_profile();
        let meta = client_meta(&Map::new(), Some(&bridge));
        assert!(meta.get("jetbrains").is_some());
        assert!(bridge_subagents(
            &json!({
                "agentCapabilities": { "sessionCapabilities": { "subagents": {} } }
            }),
            Some(&bridge)
        ));
        assert!(bridge_subagents(
            &json!({
                "_meta": { "jetbrains": { "air": { "version": 1, "capabilities": ["nativeSubagentSessions"] } } }
            }),
            Some(&bridge)
        ));
        assert!(!bridge_subagents(
            &json!({
                "agentCapabilities": { "sessionCapabilities": { "subagents": false } }
            }),
            Some(&bridge)
        ));
    }

    #[test]
    fn bounded_raw_truncates_utf8_cleanly_at_2048_bytes() {
        // Multi-byte chars crossing the 2048 byte boundary never leave a trailing U+FFFD.
        let text = "é".repeat(1500);
        let bounded = bounded_raw(&json!({ "text": text }));
        assert_eq!(bounded.get("truncated"), Some(&Value::Bool(true)));
        let raw_json = bounded.get("json").and_then(Value::as_str).unwrap_or("");
        assert!(raw_json.len() <= 2048);
        assert!(!raw_json.ends_with('\u{FFFD}'));
    }
}
