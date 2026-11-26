// SPDX-License-Identifier: Apache-2.0
//! Each provider's setup row: what discovery observed, what it means for readiness, and the
//! onboarding checklist. Ported from `apps/daemon/src/provider-status-row.ts` and
//! `@ace/core`'s provider readiness. Pure: the daemon passes in every observation.

use ace_protocol::generated::ProviderKind;
use ace_provider_installs::installer;
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Runtime {
    Cli,
    CursorSdk,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Auth {
    LoggedIn,
    LoggedOut,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Readiness {
    NotInstalled,
    InstalledSignedOut,
    SignedIn,
    NeedsAttention,
    NotConfigured,
    NeedsUpdate,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VersionCheckStatus {
    Ok,
    TooOld,
    Unreadable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionCheck {
    pub status: VersionCheckStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed: Option<String>,
    pub required: String,
}

/// A provider's row as clients read it. Only the fields the readiness rules and the row merge
/// decide are modelled; unknown fields from a newer daemon are a decode concern elsewhere.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: ProviderKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub readiness: Option<Readiness>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_checked_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_available: Option<bool>,
    pub runtime: Runtime,
    /// `None` while a check hasn't answered yet.
    pub installed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_check: Option<VersionCheck>,
    pub auth: Auth,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_evidence: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models_available: Option<bool>,
    pub login_hint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<i64>,
    pub stale: bool,
    pub refreshing: bool,
}

/// How old a check may grow while someone is looking before it runs again.
pub const REFRESH_MS: i64 = 300_000;

impl ProviderStatus {
    /// The row every provider starts on, before its first check: nothing is guessed.
    pub fn unchecked(provider: ProviderKind) -> ProviderStatus {
        ProviderStatus {
            provider,
            instance_id: None,
            readiness: None,
            install_hint: None,
            install_command: None,
            latest_version: None,
            version_checked_at: None,
            update_available: None,
            runtime: if provider == ProviderKind::Cursor {
                Runtime::CursorSdk
            } else {
                Runtime::Cli
            },
            installed: None,
            enabled: None,
            path: None,
            version: None,
            version_check: None,
            auth: Auth::Unknown,
            account_label: None,
            auth_detail: None,
            auth_evidence: None,
            models_available: None,
            login_hint: String::new(),
            action_id: None,
            state: None,
            error: None,
            checked_at: None,
            stale: true,
            refreshing: false,
        }
    }

    /// Whether the last check is older than the cadence at `now`.
    pub fn stale_at(&self, now: i64) -> bool {
        self.checked_at
            .is_none_or(|checked_at| now - checked_at >= REFRESH_MS)
    }
}

/// What discovery observed for one provider; invalid optional values never erase a separately
/// established installation.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DiscoveryObservation {
    pub installed: Option<bool>,
    pub auth: Option<Auth>,
    pub login_hint: Option<String>,
    pub path: Option<String>,
    pub version: Option<String>,
    pub version_check: Option<VersionCheck>,
    pub account_label: Option<String>,
    pub auth_detail: Option<String>,
    pub auth_evidence: Option<String>,
    pub error: Option<String>,
    /// A field discovery sent that this build cannot read: the row says so instead of dropping
    /// the rest of the observation.
    pub invalid: bool,
}

/// Invalid optional observations cannot erase a separately established installation.
pub fn provider_status_row(
    row: &ProviderStatus,
    observation: Option<&DiscoveryObservation>,
    at: i64,
) -> ProviderStatus {
    let observation = observation.cloned().unwrap_or_default();
    let mut result = ProviderStatus {
        provider: row.provider,
        runtime: row.runtime,
        installed: observation.installed,
        auth: observation.auth.unwrap_or(Auth::Unknown),
        login_hint: observation
            .login_hint
            .unwrap_or_else(|| row.login_hint.clone()),
        checked_at: Some(at),
        stale: false,
        refreshing: false,
        ..row.clone()
    };
    if result.installed == Some(true) && result.auth == Auth::LoggedOut {
        result.state = Some("not_configured".into());
        result.action_id = Some("provider.sign_in".into());
        if result.provider == ProviderKind::Cursor {
            result.login_hint = "Sign in to Cursor".into();
        }
    }
    result.path = observation.path;
    result.version = observation.version;
    result.version_check = observation.version_check;
    result.account_label = observation.account_label;
    result.auth_detail = observation.auth_detail;
    result.auth_evidence = observation.auth_evidence;
    result.error = observation.error;
    if observation.invalid {
        result.error = Some("Invalid optional provider metadata".into());
    }
    result
}

/// A row after its readiness is worked out. `installHint` and `installCommand` follow the
/// reviewed manifest, never a guess.
pub fn provider_readiness(row: &ProviderStatus) -> ProviderStatus {
    let spec = installer(row.provider, None);
    let install_command = spec
        .and_then(|spec| spec.package)
        .map(|package| format!("npm install -g {package}"));
    let install_hint = spec
        .and_then(|spec| spec.manual)
        .map(str::to_string)
        .unwrap_or_else(|| {
            "Install the provider with its official setup, then check again.".to_string()
        });
    let mut readiness = if row.enabled == Some(false) {
        Readiness::NotConfigured
    } else if row.installed == Some(false) {
        if row.runtime == Runtime::CursorSdk {
            Readiness::NotConfigured
        } else {
            Readiness::NotInstalled
        }
    } else if row.readiness == Some(Readiness::NeedsAttention)
        || row.installed.is_none()
        || row.error.is_some()
    {
        // A CLI that doesn't report its sign-in (`auth: unknown`) is not a problem: it counts
        // as signed in, and clients say from `auth` that the CLI didn't confirm it.
        Readiness::NeedsAttention
    } else if row.auth == Auth::LoggedOut
        && !(row.provider == ProviderKind::Opencode && row.models_available == Some(true))
    {
        Readiness::InstalledSignedOut
    } else {
        Readiness::SignedIn
    };
    if row.enabled != Some(false)
        && row.installed == Some(true)
        && row.state.as_deref() == Some("not_configured")
    {
        readiness = Readiness::InstalledSignedOut;
    }
    // Older than ace's minimum: sessions are refused until it is updated, whatever its sign-in.
    if row.enabled != Some(false)
        && row.installed == Some(true)
        && row.version_check.as_ref().map(|check| check.status) == Some(VersionCheckStatus::TooOld)
    {
        readiness = Readiness::NeedsUpdate;
    }
    // Turned off in Settings: ace never probed it, so install guidance would be a guess, and
    // sign-in is refused until it is turned back on.
    if row.enabled == Some(false) {
        let mut off = row.clone();
        off.install_hint = None;
        off.install_command = None;
        off.action_id = None;
        off.readiness = Some(readiness);
        off.login_hint = "Turned off in ace. Turn it on in Settings.".into();
        return off;
    }
    let cursor_sign_in =
        row.provider == ProviderKind::Cursor && readiness == Readiness::InstalledSignedOut;
    ProviderStatus {
        readiness: Some(readiness),
        login_hint: if cursor_sign_in {
            "Sign in to Cursor".into()
        } else {
            row.login_hint.clone()
        },
        action_id: if cursor_sign_in {
            Some("provider.sign_in".into())
        } else {
            row.action_id.clone()
        },
        install_hint: Some(install_hint),
        install_command,
        ..row.clone()
    }
}

/// What a first run should do next.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OnboardingNext {
    StartThread,
    SignIn(ProviderKind),
    Refresh,
    Configure(ProviderKind),
    Install(ProviderKind),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OnboardingChecklist {
    pub providers: Vec<ProviderStatus>,
    pub ready: Vec<ProviderKind>,
    pub next: OnboardingNext,
}

/// Cursor has one SDK runtime; legacy CLI rows cannot make it appear ready.
pub fn onboarding_checklist(rows: &[ProviderStatus]) -> OnboardingChecklist {
    let mut effective: Vec<ProviderStatus> = Vec::new();
    for row in rows {
        if row.provider == ProviderKind::Cursor && row.runtime != Runtime::CursorSdk {
            continue;
        }
        let ready = provider_readiness(row);
        match effective
            .iter_mut()
            .find(|entry| entry.provider == row.provider)
        {
            Some(entry) => *entry = ready,
            None => effective.push(ready),
        }
    }
    let ready: Vec<ProviderKind> = effective
        .iter()
        .filter(|row| row.readiness == Some(Readiness::SignedIn))
        .map(|row| row.provider)
        .collect();
    if !ready.is_empty() {
        return OnboardingChecklist {
            providers: effective,
            ready,
            next: OnboardingNext::StartThread,
        };
    }
    let signed_out = effective
        .iter()
        .find(|row| {
            row.readiness == Some(Readiness::InstalledSignedOut)
                || (row.installed == Some(true)
                    && row.readiness == Some(Readiness::NeedsAttention)
                    && row.auth == Auth::LoggedOut)
        })
        .map(|row| row.provider);
    if let Some(provider) = signed_out {
        return OnboardingChecklist {
            providers: effective,
            ready,
            next: OnboardingNext::SignIn(provider),
        };
    }
    if effective
        .iter()
        .any(|row| row.refreshing || row.installed.is_none())
    {
        return OnboardingChecklist {
            providers: effective,
            ready,
            next: OnboardingNext::Refresh,
        };
    }
    let installed = effective.iter().find(|row| row.installed == Some(true));
    let next = installed.map_or(OnboardingNext::Install(ProviderKind::Codex), |row| {
        OnboardingNext::Configure(row.provider)
    });
    OnboardingChecklist {
        providers: effective,
        ready,
        next,
    }
}

/// The last update facts, while they describe the same installed version.
pub fn previous_version_facts(
    previous: &ProviderStatus,
    current: &ProviderStatus,
) -> (Option<String>, Option<i64>, Option<bool>) {
    if previous.latest_version.is_none() || previous.version != current.version {
        return (None, None, None);
    }
    (
        previous.latest_version.clone(),
        previous.version_checked_at,
        previous.update_available,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(provider: ProviderKind) -> ProviderStatus {
        ProviderStatus {
            provider,
            runtime: Runtime::Cli,
            installed: Some(true),
            auth: Auth::LoggedOut,
            login_hint: format!("{provider} login"),
            ..ProviderStatus::unchecked(provider)
        }
    }

    // packages/core/src/provider-readiness.test.ts
    // "first run recommends sign-in for installed CLIs and starting work once one is ready"
    #[test]
    fn first_run_recommends_sign_in_and_then_starting_work() {
        let codex = row(ProviderKind::Codex);
        assert_eq!(
            onboarding_checklist(std::slice::from_ref(&codex)).next,
            OnboardingNext::SignIn(ProviderKind::Codex)
        );
        let mut signed_in = codex.clone();
        signed_in.auth = Auth::LoggedIn;
        let checklist = onboarding_checklist(&[signed_in]);
        assert_eq!(checklist.ready, vec![ProviderKind::Codex]);
        assert_eq!(checklist.next, OnboardingNext::StartThread);
        let mut missing = codex.clone();
        missing.installed = Some(false);
        let checklist = onboarding_checklist(&[missing]);
        assert_eq!(checklist.next, OnboardingNext::Install(ProviderKind::Codex));
        assert_eq!(
            checklist.providers[0].install_command.as_deref(),
            Some("npm install -g @openai/codex")
        );
        let mut checking = codex;
        checking.installed = None;
        checking.refreshing = true;
        assert_eq!(
            onboarding_checklist(&[checking]).next,
            OnboardingNext::Refresh
        );
    }

    // "expired and exhausted installations stay out of the ready checklist"
    #[test]
    fn expired_and_exhausted_installations_stay_out_of_the_ready_checklist() {
        let mut expired = row(ProviderKind::Codex);
        expired.auth = Auth::LoggedIn;
        expired.error = Some("Authentication expired".into());
        assert_eq!(
            provider_readiness(&expired).readiness,
            Some(Readiness::NeedsAttention)
        );
        assert!(onboarding_checklist(&[expired]).ready.is_empty());
        let mut attention = row(ProviderKind::Codex);
        attention.readiness = Some(Readiness::NeedsAttention);
        assert!(onboarding_checklist(&[attention]).ready.is_empty());
    }

    // "a provider turned off in Settings says how to turn it on, not how to install it"
    #[test]
    fn a_provider_turned_off_says_how_to_turn_it_on() {
        let mut off = row(ProviderKind::Codex);
        off.enabled = Some(false);
        off.installed = None;
        off.auth = Auth::Unknown;
        off.action_id = Some("provider.sign_in".into());
        let off = provider_readiness(&off);
        assert_eq!(off.readiness, Some(Readiness::NotConfigured));
        assert!(off.login_hint.contains("Turn it on in Settings"));
        assert_eq!(off.install_hint, None);
        assert_eq!(off.install_command, None);
        assert_eq!(off.action_id, None);
    }

    // "a CLI that doesn't report its sign-in is usable, not a problem"
    #[test]
    fn a_cli_that_does_not_report_its_sign_in_is_usable() {
        let mut unreported = row(ProviderKind::Codex);
        unreported.auth = Auth::Unknown;
        assert_eq!(
            provider_readiness(&unreported).readiness,
            Some(Readiness::SignedIn)
        );
        assert_eq!(
            onboarding_checklist(&[unreported]).next,
            OnboardingNext::StartThread
        );
    }

    // "Cursor setup recommends SDK sign-in and never falls back to a legacy CLI"
    #[test]
    fn cursor_setup_recommends_sdk_sign_in_and_never_a_legacy_cli() {
        let mut sdk = row(ProviderKind::Cursor);
        sdk.runtime = Runtime::CursorSdk;
        sdk.state = Some("not_configured".into());
        let cli = ProviderStatus {
            runtime: Runtime::Cli,
            auth: Auth::LoggedIn,
            ..sdk.clone()
        };
        for rows in [vec![cli.clone(), sdk.clone()], vec![sdk.clone(), cli]] {
            let checklist = onboarding_checklist(&rows);
            assert_eq!(checklist.next, OnboardingNext::SignIn(ProviderKind::Cursor));
            assert_eq!(
                checklist.providers[0].readiness,
                Some(Readiness::InstalledSignedOut)
            );
            assert_eq!(checklist.providers[0].login_hint, "Sign in to Cursor");
        }
        let mut missing = sdk.clone();
        missing.installed = Some(false);
        assert_eq!(
            onboarding_checklist(&[missing]).providers[0].readiness,
            Some(Readiness::NotConfigured)
        );
        let mut signed = sdk;
        signed.state = None;
        signed.auth = Auth::LoggedIn;
        assert_eq!(
            onboarding_checklist(&[signed]).ready,
            vec![ProviderKind::Cursor]
        );
    }

    // "a CLI older than ace's minimum needs an update and is never ready, even signed in"
    #[test]
    fn a_cli_older_than_aces_minimum_needs_an_update() {
        let mut old = row(ProviderKind::Codex);
        old.auth = Auth::LoggedIn;
        old.version = Some("0.158.0".into());
        old.version_check = Some(VersionCheck {
            status: VersionCheckStatus::TooOld,
            installed: Some("0.158.0".into()),
            required: "0.159.1".into(),
        });
        assert_eq!(
            provider_readiness(&old).readiness,
            Some(Readiness::NeedsUpdate)
        );
        assert!(onboarding_checklist(&[old.clone()]).ready.is_empty());
        let current = ProviderStatus {
            version_check: Some(VersionCheck {
                status: VersionCheckStatus::Ok,
                installed: Some("0.160.0".into()),
                required: "0.159.1".into(),
            }),
            ..old
        };
        assert_eq!(
            provider_readiness(&current).readiness,
            Some(Readiness::SignedIn)
        );
    }

    // apps/daemon/src/provider-status-row.ts
    // "invalid optional observations cannot erase a separately established installation"
    #[test]
    fn an_invalid_observation_marks_the_row_without_losing_the_installation() {
        let row = row(ProviderKind::Codex);
        let observation = DiscoveryObservation {
            installed: Some(true),
            auth: Some(Auth::LoggedIn),
            version: Some("1.0.0".into()),
            invalid: true,
            ..Default::default()
        };
        let merged = provider_status_row(&row, Some(&observation), 42);
        assert_eq!(merged.installed, Some(true));
        assert_eq!(merged.auth, Auth::LoggedIn);
        assert_eq!(merged.version.as_deref(), Some("1.0.0"));
        assert_eq!(
            merged.error.as_deref(),
            Some("Invalid optional provider metadata")
        );
        assert_eq!(merged.checked_at, Some(42));
        assert!(!merged.stale);
    }

    #[test]
    fn an_installed_signed_out_cli_asks_for_sign_in() {
        let observation = DiscoveryObservation {
            installed: Some(true),
            auth: Some(Auth::LoggedOut),
            ..Default::default()
        };
        let merged = provider_status_row(&row(ProviderKind::Claude), Some(&observation), 1);
        assert_eq!(merged.state.as_deref(), Some("not_configured"));
        assert_eq!(merged.action_id.as_deref(), Some("provider.sign_in"));
    }

    #[test]
    fn the_last_update_facts_survive_only_the_same_installed_version() {
        let mut old = row(ProviderKind::Codex);
        old.version = Some("1.0.0".into());
        old.latest_version = Some("1.1.0".into());
        old.version_checked_at = Some(7);
        old.update_available = Some(true);
        let same = ProviderStatus {
            version: Some("1.0.0".into()),
            ..old.clone()
        };
        assert_eq!(
            previous_version_facts(&old, &same),
            (Some("1.1.0".into()), Some(7), Some(true))
        );
        let newer = ProviderStatus {
            version: Some("1.1.0".into()),
            ..old.clone()
        };
        assert_eq!(previous_version_facts(&old, &newer), (None, None, None));
    }
}
