// SPDX-License-Identifier: Apache-2.0
//! A provider account's identity, home and process environment, from
//! `packages/accounts/src/instances.ts` and `acp-managed-home.ts`. Only the selectors that hold
//! the CLI's own login and settings move to the account home; HOME, APPDATA and TMPDIR stay the
//! person's, so gh, git, ssh, npm and the keychain work inside an account exactly as they do in
//! a terminal (ADR 0002: ace never stores or proxies credentials).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use indexmap::IndexMap;

use crate::error::AccountsError;

/// Every provider an account can belong to. `Acp` is the generic agent protocol;
/// `Antigravity` runs through its ACP agent but is its own provider to threads and Settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Provider {
    Codex,
    Claude,
    OpenCode,
    Cursor,
    Pi,
    Acp,
    Antigravity,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Codex => "codex",
            Provider::Claude => "claude",
            Provider::OpenCode => "opencode",
            Provider::Cursor => "cursor",
            Provider::Pi => "pi",
            Provider::Acp => "acp",
            Provider::Antigravity => "antigravity",
        }
    }

    pub fn parse(value: &str) -> Option<Provider> {
        Some(match value {
            "codex" => Provider::Codex,
            "claude" => Provider::Claude,
            "opencode" => Provider::OpenCode,
            "cursor" => Provider::Cursor,
            "pi" => Provider::Pi,
            "acp" => Provider::Acp,
            "antigravity" => Provider::Antigravity,
            _ => return None,
        })
    }

    /// The five native CLIs whose own homes ace isolates (`NativeAccountProvider`).
    pub fn is_native(self) -> bool {
        !matches!(self, Provider::Acp | Provider::Antigravity)
    }
}

/// The process environment as the TypeScript sees it: derived from `process.env`, with an
/// explicit `None` masking an inherited variable (JSON `undefined`) rather than leaving it out.
pub type Env = IndexMap<String, Option<String>>;

pub fn env_from(pairs: impl IntoIterator<Item = (impl Into<String>, Option<String>)>) -> Env {
    pairs.into_iter().map(|(key, value)| (key.into(), value)).collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthMethod {
    Browser,
    ApiKey,
    Unknown,
}

impl AuthMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            AuthMethod::Browser => "browser",
            AuthMethod::ApiKey => "api_key",
            AuthMethod::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HomeStrategy {
    DefaultCli,
    Managed,
}

impl HomeStrategy {
    pub fn as_str(self) -> &'static str {
        match self {
            HomeStrategy::DefaultCli => "default_cli",
            HomeStrategy::Managed => "managed",
        }
    }
}

/// A saved account (`ProviderInstance` in `@ace/protocol/accounts`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderInstance {
    pub id: String,
    pub provider: Provider,
    pub label: String,
    pub home_dir: PathBuf,
    /// Only the provider's own selector variables, never credentials.
    pub env: IndexMap<String, String>,
    pub implicit: bool,
    pub managed: bool,
    pub home_strategy: Option<HomeStrategy>,
    pub auth_method: Option<AuthMethod>,
    pub signed_in_as: Option<String>,
    pub login_revision: Option<String>,
    pub profile_revision: Option<String>,
    pub installation_version: Option<String>,
    pub short_label: Option<String>,
    pub badge_color: Option<String>,
    pub badge_icon: Option<String>,
    pub acp_agent_id: Option<String>,
    pub installation_id: Option<String>,
    pub instance_id: Option<String>,
}

/// One or two text graphemes at most 64 UTF-16 units, no whitespace, no emoji (`AccountBadgeInput`).
fn valid_short_label(value: &str) -> bool {
    if value.is_empty() || value.chars().count() > 64 {
        return false;
    }
    if value.chars().any(char::is_whitespace) || value.chars().any(char::is_control) {
        return false;
    }
    // `\p{Cf}` (format) and emoji/keycap forms are the schema's other refusals. ASCII controls
    // are covered above; the remaining format characters are the common bidi marks.
    if value.chars().any(|c| {
        matches!(
            c,
            '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2064}'
        )
    }) {
        return false;
    }
    if value.chars().any(|c| {
        matches!(c, '\u{20e3}' | '\u{fe0f}')
            || ('\u{1f000}'..='\u{1faff}').contains(&c)
            || ('\u{2600}'..='\u{27bf}').contains(&c)
    }) {
        return false;
    }
    graphemes(value) <= 2
}

/// A small grapheme count for the badge's one-or-two rule: extended grapheme clusters we meet in
/// initials are single code points, or a base with combining marks and a variation selector.
fn graphemes(value: &str) -> usize {
    let mut count = 0;
    let mut previous_combining = false;
    for character in value.chars() {
        let combining = is_combining(character);
        if !combining && !previous_combining {
            count += 1;
        } else if !combining && previous_combining {
            count += 1;
        }
        previous_combining = combining;
    }
    count
}

fn is_combining(character: char) -> bool {
    matches!(
        character,
        '\u{0300}'..='\u{036f}'
            | '\u{1ab0}'..='\u{1aff}'
            | '\u{1dc0}'..='\u{1dff}'
            | '\u{20d0}'..='\u{20ff}'
            | '\u{fe20}'..='\u{fe2f}'
    )
}

impl ProviderInstance {
    fn length_error(value: &str, max: usize) -> bool {
        value.chars().count() > max
    }

    /// `ProviderInstance.parse`: the same required fields, bounds (code points, rule 17) and the
    /// ACP/native identity rules.
    pub fn validate(&self) -> Result<(), AccountsError> {
        if self.id.is_empty() || Self::length_error(&self.id, 256) {
            return Err(AccountsError::InvalidNativeIdentity);
        }
        if self.label.is_empty() || Self::length_error(&self.label, 128) {
            return Err(AccountsError::InvalidNativeIdentity);
        }
        if self.home_dir.as_os_str().is_empty() || Self::length_error(&self.home_dir.to_string_lossy(), 4096)
        {
            return Err(AccountsError::InvalidNativeIdentity);
        }
        for value in self.env.values() {
            if Self::length_error(value, 4096) {
                return Err(AccountsError::InvalidNativeIdentity);
            }
        }
        for (value, max) in [
            (self.signed_in_as.as_deref(), 256),
            (self.login_revision.as_deref(), 128),
            (self.profile_revision.as_deref(), 256),
            (self.installation_version.as_deref(), 256),
        ] {
            if value.is_some_and(|value| Self::length_error(value, max)) {
                return Err(AccountsError::InvalidNativeIdentity);
            }
        }
        if self
            .short_label
            .as_deref()
            .is_some_and(|value| !valid_short_label(value))
        {
            return Err(AccountsError::InvalidNativeIdentity);
        }
        if self.implicit && (self.managed || self.provider == Provider::Acp || !self.env.is_empty()) {
            return Err(AccountsError::ImplicitSelectors);
        }
        if self.provider == Provider::Acp {
            let identity = self.acp_agent_id.is_some()
                && self.installation_id.is_some()
                && self.instance_id.as_deref() == Some(self.id.as_str());
            let managed_home = self.home_strategy == Some(HomeStrategy::Managed)
                && self.managed
                && !self.env.is_empty();
            let default_home = self.home_strategy == Some(HomeStrategy::DefaultCli)
                && !self.managed
                && self.env.is_empty();
            if !identity || !(managed_home || default_home) {
                return Err(AccountsError::AcpIdentity);
            }
        } else if !valid_account_id(&self.id)
            || self.acp_agent_id.is_some()
            || self.installation_id.is_some()
            || self.instance_id.is_some()
            || self.home_strategy.is_some()
        {
            return Err(AccountsError::InvalidNativeIdentity);
        }
        Ok(())
    }
}

/// `AccountId`: an ASCII letter or digit, then up to 127 of `[a-zA-Z0-9_-]` (zod `.regex`).
fn valid_account_id(value: &str) -> bool {
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    characters
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && value.chars().count() <= 128
}

/// `resolve(path)`: absolute against the current directory, lexical `.`/`..` removed.
fn resolve(path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    if path.is_absolute() {
        normalize(path)
    } else {
        normalize(&std::env::current_dir().unwrap_or_default().join(path))
    }
}

fn normalize(path: &Path) -> PathBuf {
    let mut parts: Vec<std::ffi::OsString> = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                parts.pop();
            }
            other => parts.push(other.as_os_str().to_os_string()),
        }
    }
    parts.iter().collect()
}

/// The selectors each provider's environment holds, in the order `createInstance` writes them.
fn selector_env(provider: Provider, home_dir: &Path) -> IndexMap<String, String> {
    let mut env = IndexMap::new();
    match provider {
        Provider::Codex => {
            env.insert("CODEX_HOME".into(), home_dir.to_string_lossy().into());
        }
        Provider::Claude => {
            env.insert("CLAUDE_CONFIG_DIR".into(), home_dir.to_string_lossy().into());
        }
        Provider::Pi => {
            env.insert(
                "PI_CODING_AGENT_DIR".into(),
                home_dir.to_string_lossy().into(),
            );
        }
        Provider::Cursor => {
            env.insert("CURSOR_DATA_DIR".into(), home_dir.to_string_lossy().into());
        }
        Provider::OpenCode => {
            env.insert(
                "XDG_DATA_HOME".into(),
                home_dir.join("data").to_string_lossy().into(),
            );
            env.insert(
                "XDG_CONFIG_HOME".into(),
                home_dir.join("config").to_string_lossy().into(),
            );
            env.insert(
                "XDG_STATE_HOME".into(),
                home_dir.join("state").to_string_lossy().into(),
            );
            env.insert(
                "XDG_CACHE_HOME".into(),
                home_dir.join("cache").to_string_lossy().into(),
            );
        }
        Provider::Acp | Provider::Antigravity => {}
    }
    env
}

/// `createInstance`: an account in its own home, with only that provider's selectors.
pub fn create_instance(
    id: impl Into<String>,
    provider: Provider,
    label: impl Into<String>,
    home_dir: impl AsRef<Path>,
) -> Result<ProviderInstance, AccountsError> {
    if provider == Provider::Acp {
        return Err(AccountsError::AcpNeedsIdentity);
    }
    let home_dir = resolve(home_dir);
    let instance = ProviderInstance {
        id: id.into(),
        provider,
        label: label.into(),
        env: selector_env(provider, &home_dir),
        home_dir,
        implicit: false,
        managed: false,
        home_strategy: None,
        auth_method: None,
        signed_in_as: None,
        login_revision: None,
        profile_revision: None,
        installation_version: None,
        short_label: None,
        badge_color: None,
        badge_icon: None,
        acp_agent_id: None,
        installation_id: None,
        instance_id: None,
    };
    instance.validate()?;
    Ok(instance)
}

/// The person's variables an account never inherits: every provider credential, and the
/// variables that select one.
const AUTH_OVERRIDES: &[&str] = &[
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    // Claude reads its login from this folder ahead of CLAUDE_CONFIG_DIR; an empty value
    // selects the person's own default login.
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "CURSOR_API_KEY",
    "CURSOR_AUTH_TOKEN",
    "OPENCODE_DB",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_CONFIG_CONTENT",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    CursorSdk,
    Acp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Darwin,
    Linux,
    Windows,
}

impl Platform {
    pub fn current() -> Platform {
        match std::env::consts::OS {
            "windows" => Platform::Windows,
            "macos" => Platform::Darwin,
            _ => Platform::Linux,
        }
    }

    fn is_windows(self) -> bool {
        self == Platform::Windows
    }
}

/// `path.join` for the platform the environment belongs to.
fn join_for(platform: Platform, base: &str, child: &str) -> String {
    join_segments(platform, base, &[child])
}

fn join_segments(platform: Platform, base: &str, children: &[&str]) -> String {
    let separator = if platform.is_windows() { '\\' } else { '/' };
    let mut joined = base.trim_end_matches(['/', '\\']).to_string();
    for child in children {
        if joined.is_empty() {
            joined = (*child).to_string();
        } else {
            joined.push(separator);
            joined.push_str(child);
        }
    }
    joined
}

/// `ghConfigDir`: the person's own GitHub CLI config, which OpenCode's moved XDG_CONFIG_HOME
/// would otherwise redirect.
fn gh_config_dir(platform: Platform, env: &Env) -> Option<String> {
    let value = |key: &str| env.get(key).and_then(|value| value.as_deref());
    if let Some(explicit) = value("GH_CONFIG_DIR") {
        return Some(explicit.to_string());
    }
    if let Some(xdg) = value("XDG_CONFIG_HOME") {
        return Some(join_for(platform, xdg, "gh"));
    }
    if platform.is_windows() {
        if let Some(app_data) = value("APPDATA") {
            return Some(join_for(platform, app_data, "GitHub CLI"));
        }
        return value("USERPROFILE").map(|home| join_segments(platform, home, &[".config", "gh"]));
    }
    value("HOME").map(|home| join_segments(platform, home, &[".config", "gh"]))
}

fn get<'a>(env: &'a Env, key: &str) -> Option<&'a str> {
    env.get(key).and_then(|value| value.as_deref())
}

/// `appliedSelectors`: only the selectors that hold the CLI's own login and settings.
fn applied_selectors(instance: &ProviderInstance, base: &Env, platform: Platform) -> IndexMap<String, String> {
    if instance.provider != Provider::OpenCode {
        return instance.env.clone();
    }
    let mut applied = IndexMap::new();
    for key in ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME"] {
        if let Some(value) = instance.env.get(key) {
            applied.insert(key.to_string(), value.clone());
        }
    }
    if let Some(gh) = gh_config_dir(platform, base) {
        applied.insert("GH_CONFIG_DIR".to_string(), gh);
    }
    applied
}

/// `cursorSdkEnvironment`: the SDK reads `os.homedir()` and keeps its login under it, so the
/// SDK's account is the one exception that moves HOME.
fn cursor_sdk_environment(home_dir: &Path, launch: &Env) -> Env {
    let mut env = launch.clone();
    let home = home_dir.join("user").to_string_lossy().into_owned();
    env.insert("HOME".into(), Some(home.clone()));
    env.insert("USERPROFILE".into(), Some(home));
    // The SDK takes CURSOR_API_KEY, even an empty one, over the home's saved login, and an empty
    // key never signs in, so it is dropped rather than allowed to hide that login.
    let api_key = get(launch, "CURSOR_API_KEY")
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    env.insert("CURSOR_API_KEY".into(), api_key);
    for key in [
        "CURSOR_AUTH_TOKEN",
        "CURSOR_CONFIG_DIR",
        "CURSOR_DATA_DIR",
        "CURSOR_BACKEND_URL",
        "CURSOR_WEBSITE_URL",
        "NODE_OPTIONS",
        "NODE_PATH",
    ] {
        env.insert(key.into(), None);
    }
    env
}

/// The verified managed-home profile for an ACP agent (ADR 0044). Only Antigravity has one.
pub struct ManagedAcpHome {
    pub selector: &'static str,
    pub fixed: &'static [(&'static str, &'static str)],
    pub cleared: &'static [&'static str],
}

pub const ANTIGRAVITY_ACP_AGENT_ID: &str = "official:antigravity-acp";

pub fn acp_managed_home(acp_agent_id: &str) -> Option<&'static ManagedAcpHome> {
    static ANTIGRAVITY: ManagedAcpHome = ManagedAcpHome {
        selector: "GEMINI_HOME",
        fixed: &[("AGY_ACP_FORCE_FILE_STORAGE", "true")],
        cleared: &[
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "GOOGLE_CLOUD_PROJECT",
            "GOOGLE_CLOUD_LOCATION",
            "GOOGLE_CLOUD_QUOTA_PROJECT",
            "GOOGLE_GENAI_USE_VERTEXAI",
            "AGY_ACP_CCPA_PROJECT",
            "AGY_ACP_ENABLE_OAUTH",
            "AGY_GATEWAY_API_KEY",
            "AGY_LLM_GATEWAY_API_KEY",
        ],
    };
    (acp_agent_id == ANTIGRAVITY_ACP_AGENT_ID).then_some(&ANTIGRAVITY)
}

fn managed_acp_profile(instance: &ProviderInstance) -> Result<&'static ManagedAcpHome, AccountsError> {
    if instance.provider != Provider::Acp || instance.home_strategy != Some(HomeStrategy::Managed) {
        return Err(AccountsError::AcpIsolationUnverified);
    }
    instance
        .acp_agent_id
        .as_deref()
        .and_then(acp_managed_home)
        .ok_or(AccountsError::AcpIsolationUnverified)
}

fn managed_acp_env(instance: &ProviderInstance, base: &Env) -> Result<Env, AccountsError> {
    let profile = managed_acp_profile(instance)?;
    let expected = instance
        .env
        .get(profile.selector)
        .is_some_and(|value| Path::new(value) == resolve(&instance.home_dir));
    if !expected || instance.env.len() != 1 {
        return Err(AccountsError::HomeSelectorMismatch);
    }
    let mut env = base.clone();
    for key in profile.cleared {
        env.insert((*key).into(), None);
    }
    env.insert(
        profile.selector.to_string(),
        Some(resolve(&instance.home_dir).to_string_lossy().into_owned()),
    );
    for (key, value) in profile.fixed {
        env.insert((*key).to_string(), Some((*value).to_string()));
    }
    Ok(env)
}

/// `instanceEnv`: the person's environment with this account's selectors, and no inherited
/// provider credential. An implicit account runs as the person does.
pub fn instance_env(
    instance: &ProviderInstance,
    base: &Env,
    backend: Option<Backend>,
    platform: Platform,
) -> Result<Env, AccountsError> {
    instance.validate()?;
    if instance.implicit {
        return Ok(base.clone());
    }
    if instance.provider == Provider::Acp {
        return if instance.home_strategy == Some(HomeStrategy::Managed) {
            managed_acp_env(instance, base)
        } else {
            Ok(base.clone())
        };
    }
    let allowed: BTreeSet<&str> = match instance.provider {
        Provider::Codex => ["CODEX_HOME"].into_iter().collect(),
        Provider::Claude => ["CLAUDE_CONFIG_DIR"].into_iter().collect(),
        Provider::Pi => ["PI_CODING_AGENT_DIR"].into_iter().collect(),
        Provider::Cursor => ["CURSOR_DATA_DIR"].into_iter().collect(),
        _ => ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]
            .into_iter()
            .collect(),
    };
    if instance.env.keys().any(|key| !allowed.contains(key.as_str())) {
        return Err(AccountsError::ConflictingEnvironment);
    }
    let expected = selector_env(instance.provider, &resolve(&instance.home_dir));
    if instance.provider != Provider::OpenCode && instance.env != expected {
        return Err(AccountsError::HomeSelectorMismatch);
    }
    if instance.provider == Provider::OpenCode
        && (!instance.env.contains_key("XDG_DATA_HOME")
            || !instance.env.contains_key("XDG_CONFIG_HOME"))
    {
        return Err(AccountsError::OpenCodeRoots);
    }
    let mut env = base.clone();
    for key in AUTH_OVERRIDES {
        env.insert((*key).into(), None);
    }
    if instance.provider == Provider::Cursor
        && backend == Some(Backend::CursorSdk)
        && instance.auth_method != Some(AuthMethod::ApiKey)
    {
        env.insert(
            "CURSOR_API_KEY".into(),
            get(base, "CURSOR_API_KEY").map(str::to_string),
        );
    }
    for (key, value) in applied_selectors(instance, base, platform) {
        env.insert(key, Some(value));
    }
    if instance.provider == Provider::Cursor && backend == Some(Backend::CursorSdk) {
        return Ok(cursor_sdk_environment(&instance.home_dir, &env));
    }
    Ok(env)
}

/// `loginArgs`: the CLI's own sign-in command, never a credential ace handles.
pub fn login_args(provider: Provider, api: bool) -> Result<Vec<String>, AccountsError> {
    Ok(match provider {
        Provider::Codex => {
            if api {
                return Err(AccountsError::ApiKeyHandoff);
            }
            vec!["login".into()]
        }
        Provider::Pi => Vec::new(),
        Provider::Claude => vec![
            "auth".into(),
            "login".into(),
            if api { "--console" } else { "--claudeai" }.into(),
        ],
        Provider::Cursor => return Err(AccountsError::CursorSignIn),
        Provider::OpenCode => open_code_auth_args("login"),
        Provider::Acp | Provider::Antigravity => open_code_auth_args("login"),
    })
}

/// `logoutArgs`.
pub fn logout_args(provider: Provider) -> Result<Vec<String>, AccountsError> {
    Ok(match provider {
        Provider::Pi => Vec::new(),
        Provider::Cursor => return Err(AccountsError::CursorSignOut),
        Provider::OpenCode => open_code_auth_args("logout"),
        Provider::Codex => vec!["logout".into()],
        Provider::Acp | Provider::Antigravity => open_code_auth_args("logout"),
        Provider::Claude => vec!["auth".into(), "logout".into()],
    })
}

/// `openCodeAuthArgs`: OpenCode's non-interactive `auth login|logout`.
fn open_code_auth_args(action: &str) -> Vec<String> {
    vec!["auth".into(), action.into(), "--non-interactive".into()]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn instance(provider: Provider) -> ProviderInstance {
        create_instance(
            provider.as_str(),
            provider,
            provider.as_str(),
            format!("/tmp/{}", provider.as_str()),
        )
        .expect("a valid instance")
    }

    fn base() -> Env {
        env_from([
            ("PATH", Some("/fake".to_string())),
            ("OPENAI_API_KEY", Some("never-persist".into())),
            ("ANTHROPIC_API_KEY", Some("never-persist".into())),
            ("CURSOR_API_KEY", Some("never-persist".into())),
            ("OPENCODE_DB", Some("/shared/db".into())),
        ])
    }

    // packages/accounts/src/instances.process.test.ts
    // "each provider selects an independent home and strips ambient auth overrides"
    #[test]
    fn each_provider_selects_an_independent_home_and_strips_ambient_auth_overrides() {
        let base = base();
        assert_eq!(
            get(&instance_env(&instance(Provider::Codex), &base, None, Platform::Darwin).expect("codex"), "CODEX_HOME"),
            Some("/tmp/codex")
        );
        assert_eq!(
            get(&instance_env(&instance(Provider::Claude), &base, None, Platform::Darwin).expect("claude"), "CLAUDE_CONFIG_DIR"),
            Some("/tmp/claude")
        );
        let cursor = instance_env(
            &instance(Provider::Cursor),
            &base,
            Some(Backend::CursorSdk),
            Platform::Darwin,
        )
        .expect("cursor");
        assert_eq!(get(&cursor, "HOME"), Some("/tmp/cursor/user"));
        assert_eq!(get(&cursor, "USERPROFILE"), Some("/tmp/cursor/user"));
        assert_eq!(get(&cursor, "CURSOR_API_KEY"), Some("never-persist"));
        assert_eq!(get(&cursor, "CURSOR_DATA_DIR"), None);
        assert_eq!(get(&cursor, "CURSOR_CONFIG_DIR"), None);
        let opencode = instance_env(&instance(Provider::OpenCode), &base, None, Platform::Darwin).expect("opencode");
        assert_eq!(get(&opencode, "XDG_DATA_HOME"), Some("/tmp/opencode/data"));
        assert_eq!(get(&opencode, "XDG_STATE_HOME"), Some("/tmp/opencode/state"));
        assert_eq!(get(&opencode, "XDG_CONFIG_HOME"), Some("/tmp/opencode/config"));
        for provider in [Provider::Codex, Provider::Claude, Provider::Cursor, Provider::OpenCode] {
            let env = instance_env(&instance(provider), &base, None, Platform::Darwin).expect("env");
            assert_eq!(get(&env, "OPENAI_API_KEY"), None);
            assert_eq!(get(&env, "ANTHROPIC_API_KEY"), None);
            assert_eq!(get(&env, "CURSOR_API_KEY"), None);
            assert_eq!(get(&env, "OPENCODE_DB"), None);
            assert_eq!(get(&env, "PATH"), Some("/fake"));
        }
    }

    // "isolated accounts keep the person's own home, config root and temp folder for their tools"
    #[test]
    fn isolated_accounts_keep_the_persons_own_home_config_root_and_temp_folder() {
        let person = env_from([
            ("PATH", Some("/fake".into())),
            ("HOME", Some("/Users/person".into())),
            ("USERPROFILE", Some("C:\\Users\\person".into())),
            ("APPDATA", Some("C:\\Users\\person\\AppData\\Roaming".into())),
            ("XDG_CONFIG_HOME", Some("/Users/person/.config".into())),
            ("XDG_CACHE_HOME", Some("/Users/person/.cache".into())),
            ("TMPDIR", Some("/private/tmp/person".into())),
            ("TEMP", Some("C:\\Temp".into())),
            ("GH_TOKEN", Some("person-github-token".into())),
            ("SSH_AUTH_SOCK", Some("/private/tmp/agent.sock".into())),
        ]);
        for provider in [Provider::Codex, Provider::Claude] {
            let mut managed = instance(provider);
            managed.managed = true;
            let env = instance_env(&managed, &person, None, Platform::Darwin).expect("env");
            for (key, value) in &person {
                assert_eq!(env.get(key), Some(value));
            }
        }
    }

    // "an isolated OpenCode account keeps its own config while gh still finds the person's"
    #[test]
    fn an_isolated_opencode_account_keeps_its_own_config_while_gh_still_finds_the_persons() {
        let mut managed = instance(Provider::OpenCode);
        managed.managed = true;
        let person = env_from([
            ("HOME", Some("/Users/person".into())),
            ("TMPDIR", Some("/private/tmp/person".into())),
            ("PATH", Some("/fake".into())),
        ]);
        let env = instance_env(&managed, &person, None, Platform::Darwin).expect("env");
        assert_eq!(get(&env, "XDG_DATA_HOME"), Some("/tmp/opencode/data"));
        assert_eq!(get(&env, "XDG_STATE_HOME"), Some("/tmp/opencode/state"));
        assert_eq!(get(&env, "XDG_CONFIG_HOME"), Some("/tmp/opencode/config"));
        assert_eq!(get(&env, "GH_CONFIG_DIR"), Some("/Users/person/.config/gh"));
        let windows = env_from([
            ("USERPROFILE", Some("C:\\Users\\person".into())),
            ("APPDATA", Some("C:\\Users\\person\\AppData\\Roaming".into())),
        ]);
        assert_eq!(
            get(&instance_env(&managed, &windows, None, Platform::Windows).expect("windows"), "GH_CONFIG_DIR"),
            Some("C:\\Users\\person\\AppData\\Roaming\\GitHub CLI")
        );
        let custom = env_from([
            ("HOME", Some("/Users/person".into())),
            ("GH_CONFIG_DIR", Some("/custom/gh".into())),
        ]);
        assert_eq!(
            get(&instance_env(&managed, &custom, None, Platform::Darwin).expect("custom"), "GH_CONFIG_DIR"),
            Some("/custom/gh")
        );
    }

    // "an inherited Claude secure-storage folder cannot point an isolated account at another login"
    #[test]
    fn an_inherited_claude_secure_storage_folder_cannot_point_at_another_login() {
        let mut managed = instance(Provider::Claude);
        managed.managed = true;
        for inherited in ["", "/Users/person/.claude"] {
            let env = instance_env(
                &managed,
                &env_from([("CLAUDE_SECURESTORAGE_CONFIG_DIR", Some(inherited.into()))]),
                None,
                Platform::Darwin,
            )
            .expect("env");
            assert_eq!(get(&env, "CLAUDE_SECURESTORAGE_CONFIG_DIR"), None);
            assert_eq!(get(&env, "CLAUDE_CONFIG_DIR"), Some("/tmp/claude"));
        }
    }

    #[test]
    fn acp_accounts_cannot_be_created_as_a_plain_native_home() {
        assert_eq!(
            create_instance("acp", Provider::Acp, "ACP", "/tmp/acp"),
            Err(AccountsError::AcpNeedsIdentity)
        );
    }

    #[test]
    fn login_and_logout_use_the_clis_own_commands_and_refuse_cursor_and_codex_api_keys() {
        assert_eq!(login_args(Provider::Codex, false), Ok(vec!["login".into()]));
        assert_eq!(login_args(Provider::Codex, true), Err(AccountsError::ApiKeyHandoff));
        assert_eq!(
            login_args(Provider::Claude, true),
            Ok(vec!["auth".into(), "login".into(), "--console".into()])
        );
        assert_eq!(login_args(Provider::Pi, false), Ok(Vec::new()));
        assert_eq!(login_args(Provider::Cursor, false), Err(AccountsError::CursorSignIn));
        assert_eq!(logout_args(Provider::Cursor), Err(AccountsError::CursorSignOut));
        assert_eq!(
            logout_args(Provider::Claude),
            Ok(vec!["auth".into(), "logout".into()])
        );
    }

    #[test]
    fn labels_are_bounded_by_code_points_not_utf16_units() {
        // An astral character is two UTF-16 units but one code point (rule 17).
        let instance = create_instance("a", Provider::Codex, "😀".repeat(128), "/tmp/a")
            .expect("128 code points fit 128");
        assert_eq!(instance.label.encode_utf16().count(), 256);
        assert!(create_instance("a", Provider::Codex, "😀".repeat(129), "/tmp/a").is_err());
        let mut signed = instance;
        signed.signed_in_as = Some("😀".repeat(256));
        assert_eq!(signed.validate(), Ok(()));
        signed.signed_in_as = Some("😀".repeat(257));
        assert_eq!(signed.validate(), Err(AccountsError::InvalidNativeIdentity));
    }
}
