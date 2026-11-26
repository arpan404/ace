// SPDX-License-Identifier: Apache-2.0
//! The four ace modes and each provider's exact native selector (`permission-ceiling.ts`,
//! `permission-storage.ts`'s migration table, and `@ace/provider-kit/access-modes`).
//!
//! Ports `permission-ceiling.test.ts` and the mode tables `provider-permissions.process.test.ts`
//! and `permissions.process.test.ts` pin. Pure: no store, no clock.

use ace_json::Value;

/// A thread's stored access: one of the four ace modes, `custom:<native>` for an Advanced native
/// override, or none for a provider that offers no ace mode (its own default).
pub type AccessSelection = String;

/// The four modes, least to most capable (ADR 0075).
pub const ACCESS_MODE_ORDER: [&str; 4] = ["read-only", "ask", "auto-review", "full-access"];

/// The mode rank: 0 Read-only … 3 Full access; `None` for Custom/default.
pub fn rank(selection: Option<&str>) -> Option<u8> {
    let selection = selection?;
    ACCESS_MODE_ORDER
        .iter()
        .position(|mode| *mode == selection)
        .map(|index| index as u8)
}

/// Whether `selection` is one of the four ace modes.
pub fn is_access_mode(selection: &str) -> bool {
    rank(Some(selection)).is_some()
}

/// `customSelection`: an Advanced native override.
pub fn custom_selection(native: &str) -> AccessSelection {
    format!("custom:{native}")
}

/// `customNative`: the native selector a `custom:` selection names.
pub fn custom_native(selection: Option<&str>) -> Option<&str> {
    selection?.strip_prefix("custom:")
}

/// One instance's identity for policy containment (`PermissionPolicyIdentity`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Identity {
    pub provider: String,
    pub backend: Option<String>,
    pub acp_agent_id: Option<String>,
    pub installation_id: Option<String>,
    pub instance_id: Option<String>,
}

impl Identity {
    /// `PermissionPolicyIdentity.parse` (`permissions.ts:6`-`:14`): a provider and backend from
    /// their enums; every present id is 1–256 UTF-16 units (`AcpIdentity`'s bound); an ACP policy
    /// carries all three ids.
    pub fn valid(&self) -> bool {
        const PROVIDERS: [&str; 7] = [
            "claude",
            "codex",
            "opencode",
            "cursor",
            "pi",
            "acp",
            "antigravity",
        ];
        if !PROVIDERS.contains(&self.provider.as_str()) {
            return false;
        }
        if let Some(backend) = self.backend.as_deref()
            && backend != "acp"
            && backend != "cursor-sdk"
        {
            return false;
        }
        let valid_id = |field: &Option<String>| {
            field.as_deref().is_none_or(|value| {
                let units = value.encode_utf16().count();
                (1..=256).contains(&units)
            })
        };
        if !valid_id(&self.acp_agent_id)
            || !valid_id(&self.installation_id)
            || !valid_id(&self.instance_id)
        {
            return false;
        }
        self.provider != "acp"
            || (self.acp_agent_id.is_some()
                && self.installation_id.is_some()
                && self.instance_id.is_some())
    }

    pub fn new(provider: &str) -> Identity {
        Identity {
            provider: provider.to_owned(),
            ..Identity::default()
        }
    }
}

/// A policy: an identity and the selection it allows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Policy {
    pub identity: Identity,
    pub mode: Option<AccessSelection>,
}

impl Policy {
    pub fn new(identity: Identity, mode: Option<&str>) -> Policy {
        Policy {
            identity,
            mode: mode.map(str::to_owned),
        }
    }
}

/// A mode an instance offers, with the exact native selector ace sends for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Offer {
    pub mode: String,
    pub native: String,
}

impl Offer {
    pub fn new(mode: &str, native: &str) -> Offer {
        Offer {
            mode: mode.to_owned(),
            native: native.to_owned(),
        }
    }
}

fn same_identity(parent: &Identity, child: &Identity) -> bool {
    parent.provider == child.provider
        && parent.backend == child.backend
        && parent.acp_agent_id == child.acp_agent_id
        && parent.installation_id == child.installation_id
        && parent.instance_id == child.instance_id
}

/// `permissionWithinCeiling`: a child can do no more than its parent.
pub fn permission_within_ceiling(parent: &Policy, child: &Policy) -> bool {
    // Full access is unrestricted: any child, even an agent's unranked default, does no more.
    if parent.mode.as_deref() == Some("full-access") {
        return true;
    }
    let ceiling = rank(parent.mode.as_deref());
    let requested = rank(child.mode.as_deref());
    if let (Some(ceiling), Some(requested)) = (ceiling, requested) {
        return requested <= ceiling;
    }
    same_identity(&parent.identity, &child.identity) && parent.mode == child.mode
}

/// The modes a child's instance offers that an explicit request may choose under `parent`.
pub fn allowed_child_modes(parent: &Policy, offers: &[Offer]) -> Vec<String> {
    let Some(ceiling) = rank(parent.mode.as_deref()) else {
        return Vec::new();
    };
    offers
        .iter()
        .filter(|offer| rank(Some(&offer.mode)).is_some_and(|rank| rank <= ceiling))
        .map(|offer| offer.mode.clone())
        .collect()
}

/// What `inheritedPermissionMode` answers: `None` is the JavaScript `undefined` (no offered mode
/// is that strict), `Some(None)` is `null` (the parent's own unranked policy runs).
pub type Inherited = Option<Option<AccessSelection>>;

/// `inheritedPermissionMode`: the broadest mode the instance offers at or below the parent's, or
/// the parent's own unranked policy on the same identity.
pub fn inherited_permission_mode(parent: &Policy, child: &Identity, offers: &[Offer]) -> Inherited {
    let Some(mode) = parent.mode.as_deref() else {
        return same_identity(&parent.identity, child).then_some(None);
    };
    if !is_access_mode(mode) {
        return same_identity(&parent.identity, child).then(|| parent.mode.clone());
    }
    stricter_offer(mode, offers)
        .map(|offer| Some(offer.mode.clone()))
        .or_else(|| (mode == "full-access" && offers.is_empty()).then_some(None))
}

/// `ceilingMode`: the stricter of the acknowledged and requested modes; an unreported side is
/// unknown, so the reported one stands.
pub fn ceiling_mode(effective: Option<&str>, requested: Option<&str>) -> Option<AccessSelection> {
    if effective == requested || requested.is_none() {
        return effective.map(str::to_owned);
    }
    let Some(requested) = requested else {
        return effective.map(str::to_owned);
    };
    let Some(effective) = effective else {
        return Some(requested.to_owned());
    };
    let (current, next) = (rank(Some(effective)), rank(Some(requested)));
    match (current, next) {
        (Some(current), Some(next)) if next < current => Some(requested.to_owned()),
        _ => Some(effective.to_owned()),
    }
}

/// The broadest offered mode no broader than `requested`: the mode itself when offered, else the
/// nearest stricter one. Never looser.
pub fn stricter_offer<'a>(requested: &str, offers: &'a [Offer]) -> Option<&'a Offer> {
    let requested_rank = rank(Some(requested))?;
    let mut best: Option<&Offer> = None;
    for offer in offers {
        let Some(offer_rank) = rank(Some(&offer.mode)) else {
            continue;
        };
        if offer_rank <= requested_rank
            && best.is_none_or(|best| rank(Some(&best.mode)).is_some_and(|rank| offer_rank > rank))
        {
            best = Some(offer);
        }
    }
    best
}

/// The mode a thread's own choice runs as: the stricter offer when one exists, else the nearest
/// looser one, so a provider without a mode still starts.
pub fn nearest_offer<'a>(requested: &str, offers: &'a [Offer]) -> Option<&'a Offer> {
    if let Some(stricter) = stricter_offer(requested, offers) {
        return Some(stricter);
    }
    let requested_rank = rank(Some(requested))?;
    let mut looser: Option<&Offer> = None;
    for offer in offers {
        let Some(offer_rank) = rank(Some(&offer.mode)) else {
            continue;
        };
        if offer_rank > requested_rank
            && looser
                .is_none_or(|looser| rank(Some(&looser.mode)).is_some_and(|rank| offer_rank < rank))
        {
            looser = Some(offer);
        }
    }
    looser
}

/// The native selector a selection runs as (`nativeFor`).
pub fn native_for(selection: Option<&str>, offers: &[Offer]) -> Option<String> {
    let selection = selection?;
    if let Some(native) = custom_native(Some(selection)) {
        return Some(native.to_owned());
    }
    offers
        .iter()
        .find(|offer| offer.mode == selection)
        .map(|offer| offer.native.clone())
}

/// One provider's fixed native selectors (`providerNatives`).
fn provider_natives(provider: &str) -> Vec<(&'static str, String)> {
    match provider {
        "claude" => vec![
            ("read-only", "plan".to_owned()),
            ("ask", "default".to_owned()),
            ("auto-review", "auto".to_owned()),
            ("full-access", "bypassPermissions".to_owned()),
        ],
        "codex" => vec![
            ("read-only", codex(":read-only", "never", "user")),
            ("ask", codex(":read-only", "on-request", "user")),
            (
                "auto-review",
                codex(":workspace", "on-request", "auto_review"),
            ),
            ("full-access", codex(":danger-full-access", "never", "user")),
        ],
        "opencode" => vec![
            ("read-only", "plan+ace".to_owned()),
            ("ask", "build+ask".to_owned()),
            ("full-access", "build+allow".to_owned()),
        ],
        "cursor" => vec![
            ("auto-review", cursor_mode(true, true)),
            ("full-access", cursor_mode(false, false)),
        ],
        "pi" => vec![
            ("read-only", "tools:read,grep,find,ls".to_owned()),
            ("full-access", "unrestricted".to_owned()),
        ],
        "antigravity" => vec![("full-access", "yolo".to_owned())],
        _ => Vec::new(),
    }
}

fn codex(permissions: &str, approval_policy: &str, approvals_reviewer: &str) -> String {
    format!(
        "{{\"permissions\":{},\"approvalPolicy\":{},\"approvalsReviewer\":{}}}",
        ace_json::to_string(&Value::from(permissions)),
        ace_json::to_string(&Value::from(approval_policy)),
        ace_json::to_string(&Value::from(approvals_reviewer)),
    )
}

fn cursor_mode(enabled: bool, auto_review: bool) -> String {
    format!("{{\"sandboxOptions\":{{\"enabled\":{enabled}}},\"autoReview\":{auto_review}}}")
}

/// One ACP agent profile's selectors (`acpProfiles`).
fn acp_profile(profile: Option<&str>) -> Vec<(&'static str, &'static str)> {
    match profile {
        Some("gemini-043") | Some("qwen-modern") => {
            vec![
                ("read-only", "plan"),
                ("ask", "default"),
                ("full-access", "yolo"),
            ]
        }
        Some("claude-bridge") => vec![
            ("read-only", "plan"),
            ("ask", "default"),
            ("auto-review", "auto"),
            ("full-access", "bypassPermissions"),
        ],
        Some("codex-bridge") => vec![
            ("read-only", "read-only"),
            ("auto-review", "agent"),
            ("full-access", "agent-full-access"),
        ],
        _ => Vec::new(),
    }
}

/// `accessModeOffers`: the modes an instance offers, least capable first.
pub fn access_mode_offers(provider: &str, profile: Option<&str>) -> Vec<Offer> {
    let table: Vec<(&str, String)> = if provider == "acp" {
        acp_profile(profile)
            .into_iter()
            .map(|(mode, native)| (mode, native.to_owned()))
            .collect()
    } else {
        provider_natives(provider)
    };
    ACCESS_MODE_ORDER
        .iter()
        .flat_map(|mode| {
            table
                .iter()
                .find(|(name, _)| name == mode)
                .map(|(_, native)| Offer::new(mode, native))
        })
        .collect()
}

/// `reportedOrTable`: what an instance offers: its reported offers, else ace's table for a
/// first-party provider. An ACP agent reports its modes only once a session opens.
pub fn offers_of(provider: &str, capabilities: Option<&Value>) -> Vec<Offer> {
    if let Some(reported) = capabilities.and_then(|value| value.get("accessModes")) {
        let Some(offers) = reported.as_array() else {
            return Vec::new();
        };
        return offers
            .iter()
            .filter_map(|offer| {
                Some(Offer::new(
                    offer.get("mode").and_then(Value::as_str)?,
                    offer.get("native").and_then(Value::as_str)?,
                ))
            })
            .collect();
    }
    if provider == "acp" {
        return Vec::new();
    }
    access_mode_offers(provider, None)
}

/// `supportsPermissionMode`: whether an instance accepts a native selector.
pub fn supports_permission_mode(capabilities: Option<&Value>, mode: Option<&str>) -> bool {
    let Some(mode) = mode else {
        return true;
    };
    let access_modes = capabilities
        .and_then(|value| value.get("accessModes"))
        .and_then(Value::as_array);
    if access_modes.is_some_and(|offers| {
        offers
            .iter()
            .any(|offer| offer.get("native").and_then(Value::as_str) == Some(mode))
    }) {
        return true;
    }
    let choices = capabilities
        .and_then(|value| value.get("permissions"))
        .and_then(|permissions| permissions.get("permissionModes"))
        .and_then(Value::as_array);
    match choices {
        Some(choices) if !choices.is_empty() => choices
            .iter()
            .any(|choice| choice.get("id").and_then(Value::as_str) == Some(mode)),
        _ => true,
    }
}

/// `storedAccess`: the ace mode a stored native id maps to (ADR 0075's one-time load mapping).
/// `None` means the value has no ace equivalent and the defaults apply.
pub fn stored_access(provider: &str, stored: Option<&str>) -> Option<String> {
    let stored = stored?;
    if is_access_mode(stored) {
        return Some(stored.to_owned());
    }
    let mapped = match provider {
        "claude" => match stored {
            "plan" => Some("read-only"),
            "default" | "dontAsk" => Some("ask"),
            "acceptEdits" | "auto" => Some("auto-review"),
            "bypassPermissions" => Some("full-access"),
            _ => None,
        },
        "codex" => {
            let permissions = if let Some(rest) = stored.strip_prefix('{') {
                let text = format!("{{{rest}");
                let parsed = ace_json::parse(&text).ok();
                parsed.and_then(|value| {
                    value
                        .get("permissions")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })?
            } else {
                stored.to_owned()
            };
            match permissions.as_str() {
                ":read-only" => Some("read-only"),
                ":workspace" => Some("auto-review"),
                ":danger-full-access" => Some("full-access"),
                // A custom permission profile can't be ranked; it runs no broader than Ask.
                _ => Some("ask"),
            }
        }
        "opencode" => match stored {
            "plan" => Some("read-only"),
            "build" => Some("auto-review"),
            _ => None,
        },
        "cursor" => {
            let parsed = ace_json::parse(stored).ok()?;
            let enabled = parsed
                .get("sandboxOptions")
                .and_then(|sandbox| sandbox.get("enabled"))
                .and_then(Value::as_bool)?;
            let auto_review = parsed.get("autoReview").and_then(Value::as_bool)?;
            Some(if !enabled && !auto_review {
                "full-access"
            } else {
                "auto-review"
            })
        }
        "pi" => None,
        "acp" | "antigravity" => match stored {
            "plan" | "read-only" => Some("read-only"),
            "default" => Some("ask"),
            "auto_edit" | "auto-edit" | "acceptEdits" | "auto" | "agent" | "workspace-write" => {
                Some("auto-review")
            }
            "yolo" | "bypassPermissions" | "agent-full-access" => Some("full-access"),
            _ => None,
        },
        _ => None,
    };
    mapped.map(str::to_owned)
}

#[cfg(test)]
mod tests {
    //! `permission-ceiling.test.ts`: a child at or below its parent's mode is contained on any
    //! provider; a refused child learns the modes its target supports under the parent; an
    //! inherited mode steps down to the nearest stricter mode; an unranked parent contains only
    //! its identical policy; a pending change is measured by the stricter mode.
    //!
    //! `provider-permissions.process.test.ts`: each provider lists only the modes it genuinely
    //! supports, with the exact native setting. `permissions.process.test.ts`: stored native
    //! Claude modes map once to ace modes.

    use super::*;

    fn identity(provider: &str, instance: &str) -> Identity {
        Identity {
            provider: provider.to_owned(),
            instance_id: Some(instance.to_owned()),
            ..Identity::default()
        }
    }

    fn acp_identity(instance: &str) -> Identity {
        Identity {
            provider: "acp".to_owned(),
            acp_agent_id: Some("local:one".to_owned()),
            installation_id: Some("approved-one".to_owned()),
            instance_id: Some(instance.to_owned()),
            ..Identity::default()
        }
    }

    #[test]
    fn a_child_at_or_below_its_parents_mode_is_contained_on_any_provider() {
        let opencode = identity("opencode", "opencode-cli-default");
        let claude = identity("claude", "claude-cli-default");
        assert!(permission_within_ceiling(
            &Policy::new(opencode.clone(), Some("ask")),
            &Policy::new(claude.clone(), Some("read-only")),
        ));
        assert!(permission_within_ceiling(
            &Policy::new(opencode.clone(), Some("ask")),
            &Policy::new(claude.clone(), Some("ask")),
        ));
        for mode in ["auto-review", "full-access"] {
            assert!(!permission_within_ceiling(
                &Policy::new(opencode.clone(), Some("ask")),
                &Policy::new(claude.clone(), Some(mode)),
            ));
        }
    }

    #[test]
    fn a_refused_child_learns_the_modes_its_target_supports_under_the_parent() {
        let opencode = identity("opencode", "opencode-cli-default");
        let claude = identity("claude", "claude-cli-default");
        let cursor = identity("cursor", "cursor-sdk-default");
        assert_eq!(
            allowed_child_modes(
                &Policy::new(claude.clone(), Some("auto-review")),
                &access_mode_offers("opencode", None)
            ),
            vec!["read-only", "ask"]
        );
        // Cursor supports nothing as strict as Ask.
        assert_eq!(
            allowed_child_modes(
                &Policy::new(claude, Some("ask")),
                &access_mode_offers("cursor", None)
            ),
            Vec::<String>::new()
        );
        assert_eq!(opencode.provider, "opencode");
        assert_eq!(cursor.provider, "cursor");
    }

    #[test]
    fn an_inherited_mode_steps_down_to_the_nearest_stricter_mode_the_target_supports() {
        let opencode = identity("opencode", "opencode-cli-default");
        let claude = identity("claude", "claude-cli-default");
        let cursor = identity("cursor", "cursor-sdk-default");
        assert_eq!(
            inherited_permission_mode(
                &Policy::new(claude.clone(), Some("auto-review")),
                &opencode,
                &access_mode_offers("opencode", None)
            ),
            Some(Some("ask".to_owned()))
        );
        assert_eq!(
            inherited_permission_mode(
                &Policy::new(claude, Some("full-access")),
                &cursor,
                &access_mode_offers("cursor", None)
            ),
            Some(Some("full-access".to_owned()))
        );
        assert_eq!(
            inherited_permission_mode(
                &Policy::new(identity("claude", "claude-cli-default"), Some("ask")),
                &cursor,
                &access_mode_offers("cursor", None)
            ),
            None
        );
    }

    #[test]
    fn an_unranked_parent_contains_only_its_identical_policy() {
        let acp = acp_identity("one:default");
        assert!(permission_within_ceiling(
            &Policy::new(acp.clone(), None),
            &Policy::new(acp.clone(), None)
        ));
        assert!(!permission_within_ceiling(
            &Policy::new(acp.clone(), None),
            &Policy::new(acp_identity("other"), None)
        ));
        assert!(!permission_within_ceiling(
            &Policy::new(acp.clone(), None),
            &Policy::new(identity("claude", "claude-cli-default"), Some("read-only"))
        ));
        assert!(permission_within_ceiling(
            &Policy::new(
                identity("claude", "claude-cli-default"),
                Some("custom:dontAsk")
            ),
            &Policy::new(
                identity("claude", "claude-cli-default"),
                Some("custom:dontAsk")
            )
        ));
        assert_eq!(
            inherited_permission_mode(&Policy::new(acp.clone(), None), &acp, &[]),
            Some(None)
        );
    }

    #[test]
    fn a_pending_change_is_measured_by_the_stricter_of_the_running_and_requested_modes() {
        assert_eq!(
            ceiling_mode(Some("full-access"), Some("read-only")),
            Some("read-only".to_owned())
        );
        assert_eq!(
            ceiling_mode(Some("read-only"), Some("full-access")),
            Some("read-only".to_owned())
        );
        assert_eq!(ceiling_mode(None, Some("ask")), Some("ask".to_owned()));
        assert_eq!(ceiling_mode(Some("ask"), None), Some("ask".to_owned()));
    }

    #[test]
    fn each_provider_lists_only_the_modes_it_genuinely_supports_with_its_exact_native_setting() {
        let table: Vec<(&str, Vec<(&str, &str)>)> = vec![
            (
                "claude",
                vec![
                    ("read-only", "plan"),
                    ("ask", "default"),
                    ("auto-review", "auto"),
                    ("full-access", "bypassPermissions"),
                ],
            ),
            (
                "opencode",
                vec![
                    ("read-only", "plan+ace"),
                    ("ask", "build+ask"),
                    ("full-access", "build+allow"),
                ],
            ),
            (
                "cursor",
                vec![
                    (
                        "auto-review",
                        "{\"sandboxOptions\":{\"enabled\":true},\"autoReview\":true}",
                    ),
                    (
                        "full-access",
                        "{\"sandboxOptions\":{\"enabled\":false},\"autoReview\":false}",
                    ),
                ],
            ),
            (
                "pi",
                vec![
                    ("read-only", "tools:read,grep,find,ls"),
                    ("full-access", "unrestricted"),
                ],
            ),
            ("antigravity", vec![("full-access", "yolo")]),
        ];
        for (provider, expected) in table {
            let offers = offers_of(provider, None);
            assert_eq!(
                offers
                    .iter()
                    .map(|offer| (offer.mode.as_str(), offer.native.as_str()))
                    .collect::<Vec<_>>(),
                expected,
                "{provider}"
            );
        }
        // An unprofiled ACP agent offers no ace mode.
        assert!(offers_of("acp", None).is_empty());
        // Codex's natives are the exact JSON ace sends.
        assert_eq!(
            offers_of("codex", None)[0].native,
            "{\"permissions\":\":read-only\",\"approvalPolicy\":\"never\",\"approvalsReviewer\":\"user\"}"
        );
    }

    #[test]
    fn reported_offers_win_and_an_empty_report_offers_nothing() {
        let reported = r#"{"accessModes":[{"mode":"ask","native":"build+ask"}]}"#;
        let offers = offers_of("claude", Some(&ace_json::parse(reported).unwrap()));
        assert_eq!(offers, vec![Offer::new("ask", "build+ask")]);
        let empty = ace_json::parse(r#"{"accessModes":[]}"#).unwrap();
        assert!(offers_of("claude", Some(&empty)).is_empty());
        // No reported field falls back to the table.
        let none = ace_json::parse("{}").unwrap();
        assert_eq!(
            offers_of("claude", Some(&none)).len(),
            4,
            "the table answers when the instance reports no offers"
        );
    }

    #[test]
    fn a_persons_pick_never_runs_looser_through_the_nearest_offer() {
        // Auto review on OpenCode (no native reviewer) steps down to Ask, never up to Full access.
        assert_eq!(
            nearest_offer("auto-review", &offers_of("opencode", None))
                .map(|offer| offer.mode.as_str()),
            Some("ask")
        );
        // Ask on Cursor has nothing as strict, so its nearest looser mode runs.
        assert_eq!(
            nearest_offer("ask", &offers_of("cursor", None)).map(|offer| offer.mode.as_str()),
            Some("auto-review")
        );
        // Read-only on Pi keeps its own read-only selector.
        assert_eq!(
            nearest_offer("read-only", &offers_of("pi", None)).map(|offer| offer.mode.as_str()),
            Some("read-only")
        );
    }

    #[test]
    fn a_policy_identity_checks_its_enums_and_the_256_unit_id_bound() {
        let acp = |agent: &str| Identity {
            provider: "acp".to_owned(),
            acp_agent_id: Some(agent.to_owned()),
            installation_id: Some("installed".to_owned()),
            instance_id: Some("one:default".to_owned()),
            ..Identity::default()
        };
        // 128 astral characters are 256 UTF-16 units: the bound, not 256 characters.
        assert!(acp(&"😀".repeat(128)).valid());
        assert!(!acp(&"😀".repeat(129)).valid());
        assert!(!acp("").valid());
        assert!(!Identity::new("bogus").valid());
        let mut backend = Identity::new("claude");
        backend.backend = Some("bogus".to_owned());
        assert!(!backend.valid());
        backend.backend = Some("cursor-sdk".to_owned());
        backend.instance_id = Some("x".repeat(257));
        assert!(!backend.valid());
        // Other providers may carry an ACP id, but it obeys the same bound.
        backend.instance_id = Some("work".to_owned());
        backend.acp_agent_id = Some("😀".repeat(129));
        assert!(!backend.valid());
    }

    #[test]
    fn stored_native_claude_modes_map_once_to_ace_modes() {
        let cases = [
            ("plan", Some("read-only")),
            ("default", Some("ask")),
            ("acceptEdits", Some("auto-review")),
            ("auto", Some("auto-review")),
            ("bypassPermissions", Some("full-access")),
            // Already an ace mode: unchanged, so a second restart maps nothing.
            ("read-only", Some("read-only")),
            ("full-access", Some("full-access")),
            ("custom:dontAsk", None),
            ("nonsense", None),
        ];
        for (stored, expected) in cases {
            assert_eq!(
                stored_access("claude", Some(stored)).as_deref(),
                expected,
                "{stored}"
            );
        }
    }

    #[test]
    fn stored_codex_and_cursor_selectors_read_their_json_and_unranked_profiles_cap_at_ask() {
        assert_eq!(
            stored_access("codex", Some("{\"permissions\":\":workspace\"}")).as_deref(),
            Some("auto-review")
        );
        assert_eq!(
            stored_access("codex", Some("{\"permissions\":\"custom-profile\"}")).as_deref(),
            Some("ask")
        );
        assert_eq!(stored_access("codex", Some("{bad")), None);
        assert_eq!(
            stored_access(
                "cursor",
                Some("{\"sandboxOptions\":{\"enabled\":true},\"autoReview\":true}")
            )
            .as_deref(),
            Some("auto-review")
        );
        assert_eq!(
            stored_access(
                "cursor",
                Some("{\"sandboxOptions\":{\"enabled\":false},\"autoReview\":false}")
            )
            .as_deref(),
            Some("full-access")
        );
        assert_eq!(stored_access("pi", Some("unrestricted")), None);
        assert_eq!(
            stored_access("acp", Some("agent")),
            Some("auto-review".to_owned())
        );
    }
}
