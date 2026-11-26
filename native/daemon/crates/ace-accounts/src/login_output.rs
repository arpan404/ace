// SPDX-License-Identifier: Apache-2.0
//! Reviewing a CLI's sign-in output, from `packages/accounts/src/login-output.ts`. Only
//! reviewed verification/authorization links, one-time codes and fixed prompts cross the wire;
//! a raw line, including unknown prompts or errors, never does. Any link that could carry a
//! credential is refused.

use regex::Regex;
use url::Url;

use crate::instance::Provider;

const CLAUDE_CODE_CALLBACK: &str = "https://platform.claude.com/oauth/code/callback";

fn allowed(provider: Provider, host: &str, path: &str) -> bool {
    let claude = matches!(
        host,
        "claude.ai" | "console.anthropic.com" | "platform.claude.com"
    ) && path == "/oauth/authorize"
        || host == "claude.com" && path == "/cai/oauth/authorize";
    let claude_any = matches!(
        host,
        "claude.ai" | "console.anthropic.com" | "platform.claude.com"
    ) && path == "/oauth/authorize"
        || host == "claude.com" && path == "/cai/oauth/authorize";
    match provider {
        Provider::Codex => {
            host == "auth.openai.com"
                && matches!(path, "/codex/device" | "/oauth/authorize" | "/authorize")
        }
        Provider::Claude => claude,
        Provider::Cursor => host == "cursor.com" && matches!(path, "/login" | "/loginDeepControl"),
        Provider::Acp => {
            claude_any
                || host == "cursor.com" && matches!(path, "/login" | "/loginDeepControl")
                || host == "accounts.google.com"
                    && matches!(path, "/o/oauth2/v2/auth" | "/o/oauth2/auth")
                || host == "github.com" && path == "/login/device"
                || host == "auth.openai.com" && path == "/codex/device"
        }
        Provider::Antigravity => {
            host == "accounts.google.com" && matches!(path, "/o/oauth2/v2/auth" | "/o/oauth2/auth")
                || host == "github.com" && path == "/login/device"
                || host == "auth.openai.com" && path == "/codex/device"
        }
        Provider::Pi => {
            claude_any
                || host == "auth.openai.com"
                    && matches!(
                        path,
                        "/oauth/authorize" | "/authorize" | "/api/accounts/authorize"
                    )
                || host == "openrouter.ai" && path == "/auth"
                || host == "github.com" && path == "/login/device"
                || host == "auth.openai.com" && path == "/codex/device"
        }
        Provider::OpenCode => {
            host == "opencode.ai" && path == "/console/device"
                || host == "github.com" && path == "/login/device"
                || host == "auth.openai.com" && path == "/codex/device"
        }
    }
}

fn allowed_fields(provider: Provider) -> Vec<&'static str> {
    let mut fields = vec![
        "client_id",
        "redirect_uri",
        "response_type",
        "scope",
        "state",
        "code_challenge",
        "code_challenge_method",
        "audience",
        "originator",
        "id_token_add_organizations",
        "codex_cli_simplified_flow",
    ];
    if matches!(provider, Provider::Cursor | Provider::Acp) {
        fields.extend(["challenge", "uuid", "mode", "redirect", "redirectTarget"]);
    }
    if provider == Provider::Acp {
        fields.push("supportsSelectedTeamLogin");
    }
    if provider == Provider::Claude {
        fields.extend(["code", "login_hint", "login_method", "orgUUID"]);
    }
    if provider == Provider::OpenCode {
        fields.push("user_code");
    }
    if provider == Provider::Pi {
        fields.extend([
            "agent_name",
            "device_id",
            "agent_host_id",
            "prompt",
            "code",
            "agent_name_hint",
            "ext_agent_host_id",
            "resource",
            "nonce",
            "callback_url",
        ]);
    }
    if matches!(provider, Provider::Acp | Provider::Antigravity) {
        fields.extend([
            "access_type",
            "prompt",
            "login_hint",
            "include_granted_scopes",
        ]);
    }
    fields
}

fn secret_in(value: &str) -> bool {
    Regex::new(r"(?:sk-|ghp_|gho_|eyJ)[A-Za-z0-9_-]{12,}")
        .is_ok_and(|pattern| pattern.is_match(value))
}

/// Only reviewed verification/authorization endpoints may cross the wire.
pub fn login_url(provider: Provider, candidate: &str) -> Option<String> {
    if candidate.encode_utf16().count() > 8192 || candidate.chars().any(char::is_whitespace) {
        return None;
    }
    let url = Url::parse(candidate).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port().is_some()
    {
        return None;
    }
    if !allowed(provider, url.host_str()?, url.path()) {
        return None;
    }
    let fields = allowed_fields(provider);
    for (key, value) in url.query_pairs() {
        if !fields.contains(&key.as_ref()) || secret_in(&value) {
            return None;
        }
        match key.as_ref() {
            "redirectTarget"
                if value != "sdk" && !(provider == Provider::Acp && value == "cli") =>
            {
                return None;
            }
            "supportsSelectedTeamLogin" if value != "true" => return None,
            "code" if value != "true" => return None,
            "redirect_uri" | "callback_url" => {
                if provider == Provider::Claude && value == CLAUDE_CODE_CALLBACK {
                    continue;
                }
                let Ok(redirect) = Url::parse(&value) else {
                    return None;
                };
                if redirect.scheme() != "http"
                    || !matches!(redirect.host_str(), Some("localhost" | "127.0.0.1"))
                    || !redirect.username().is_empty()
                    || redirect.password().is_some()
                    || redirect.query().is_some()
                    || redirect.fragment().is_some()
                {
                    return None;
                }
            }
            _ => {}
        }
    }
    Some(url.to_string())
}

fn device_code_patterns() -> Option<(Regex, Regex)> {
    let prefix =
        r"(?:(?:one[ -]time|user|device) code|enter(?: this| the)?(?: one[ -]time)? code|code:)";
    let expiry = r"(?:\s*\(expires in \d{1,3} minutes?\))?";
    let prompt = Regex::new(&format!(
        r"(?i)^\s*(?:\d+\.\s*)?{prefix}{expiry}\s*:?[\s]*$"
    ))
    .ok()?;
    let code = Regex::new(&format!(
        r"(?i){prefix}{expiry}\s*[:=]?\s*([A-Z0-9]{{4,5}}-[A-Z0-9]{{4,5}})(?:[^A-Za-z0-9_-]|$)"
    ))
    .ok()?;
    Some((prompt, code))
}

/// A reviewed device-code instruction can introduce a separate bounded code line.
pub fn login_device_code_prompt(text: &str) -> bool {
    text.encode_utf16().count() <= 512
        && device_code_patterns().is_some_and(|(prompt, _)| prompt.is_match(text))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoginState {
    AwaitingBrowser,
    AwaitingCodeEntry,
    AwaitingInput,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LoginObservation {
    pub state: Option<LoginState>,
    pub url: Option<String>,
    pub user_code: Option<String>,
    pub code_entry: bool,
    pub enter: bool,
    pub manual_required: bool,
    pub message: Option<String>,
}

impl LoginObservation {
    fn awaiting_browser() -> LoginObservation {
        LoginObservation {
            state: Some(LoginState::AwaitingBrowser),
            ..Default::default()
        }
    }

    fn awaiting_input() -> LoginObservation {
        LoginObservation {
            state: Some(LoginState::AwaitingInput),
            ..Default::default()
        }
    }
}

/// Never relay a raw line, including unknown prompts or errors.
pub fn login_observation(provider: Provider, text: &str) -> Option<LoginObservation> {
    if provider == Provider::Claude {
        let browser = Regex::new(r"(?i)opening browser to sign in").ok()?;
        let paste = Regex::new(r"(?i)paste code here if prompted").ok()?;
        let invalid =
            Regex::new(r"(?i)^\s*(?:invalid code|that code is not from this sign-in)").ok()?;
        if browser.is_match(text) || paste.is_match(text) {
            return Some(LoginObservation {
                code_entry: true,
                ..LoginObservation::awaiting_browser()
            });
        }
        if invalid.is_match(text) {
            return Some(LoginObservation {
                code_entry: true,
                message: Some(
                    "That code didn't work. Copy the whole code from the page and paste it again."
                        .into(),
                ),
                ..LoginObservation::awaiting_browser()
            });
        }
    }
    let manual = Regex::new(
        r"(?i)(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|(?:authorization|oauth) code|paste.*code)",
    )
    .ok()?;
    if manual.is_match(text) {
        let ends =
            Regex::new(r"(?i)(?:enter|paste|input|provide)|(?:key|token|code)\s*:\s*$").ok()?;
        return ends.is_match(text).then(|| LoginObservation {
            manual_required: true,
            ..LoginObservation::awaiting_input()
        });
    }
    let url_pattern = Regex::new(r#"https://[^\s<>"\x07]+"#).ok()?;
    let url = url_pattern
        .find(text)
        .and_then(|matched| login_url(provider, matched.as_str()));
    let code = device_code_patterns()
        .and_then(|(_, code)| code.captures(text))
        .and_then(|captures| captures.get(1).map(|value| value.as_str().to_uppercase()));
    if url.is_some() || code.is_some() {
        return Some(LoginObservation {
            state: Some(if code.is_some() {
                LoginState::AwaitingCodeEntry
            } else {
                LoginState::AwaitingBrowser
            }),
            url,
            user_code: code,
            ..Default::default()
        });
    }
    if Regex::new(r"(?i)press (?:enter|return)|hit enter")
        .ok()?
        .is_match(text)
    {
        return Some(LoginObservation {
            enter: true,
            ..LoginObservation::awaiting_input()
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // packages/accounts/src/login-output.test.ts
    // "only verification and authorization links reach the client"
    #[test]
    fn only_verification_and_authorization_links_reach_the_client() {
        assert_eq!(
            login_url(Provider::Codex, "https://auth.openai.com/codex/device"),
            Some("https://auth.openai.com/codex/device".into())
        );
        let claude = login_url(
            Provider::Claude,
            "https://claude.ai/oauth/authorize?client_id=example&code_challenge=public-pkce&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcallback",
        )
        .unwrap_or_default();
        assert!(claude.contains("code_challenge=public-pkce"));
        for candidate in [
            "https://auth.openai.com/codex/device?access_token=sk-SYNTHETIC0123456789",
            "https://auth.openai.com/codex/device?state=ghp_SYNTHETIC0123456789",
            "https://auth.openai.com/codex/device#sk-SYNTHETIC0123456789",
            "https://auth.openai.com/codex/device/sk-SYNTHETIC0123456789",
            "https://auth.openai.com.evil.test/codex/device",
            "https://name:password@auth.openai.com/codex/device",
            "http://auth.openai.com/codex/device",
            "https://auth.openai.com/codex/device?redirect_uri=https%3A%2F%2Fevil.test%2Fcallback",
        ] {
            assert_eq!(login_url(Provider::Codex, candidate), None, "{candidate}");
        }
    }

    // "Claude's authorize link is relayed with a localhost callback or Claude's own paste-code page"
    #[test]
    fn claudes_authorize_link_is_relayed_with_a_localhost_callback_or_paste_code_page() {
        let link = "https://claude.com/cai/oauth/authorize?code=true&client_id=synthetic&response_type=code&scope=user%3Aprofile&code_challenge=public-pkce&code_challenge_method=S256&state=public";
        let local = format!("{link}&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback");
        assert_eq!(login_url(Provider::Claude, &local), Some(local.clone()));
        let paste = format!(
            "{link}&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&login_method=sso&login_hint=person%40example.com"
        );
        assert_eq!(login_url(Provider::Claude, &paste), Some(paste.clone()));
        assert_eq!(login_url(Provider::Pi, &paste), None);
        assert_eq!(
            login_url(
                Provider::Claude,
                &paste.replace("platform.claude.com", "evil.test")
            ),
            None
        );
        assert_eq!(
            login_url(
                Provider::Claude,
                &paste.replace("%2Foauth%2Fcode%2Fcallback", "%2Fother")
            ),
            None
        );
        assert_eq!(
            login_url(
                Provider::Claude,
                &local.replace("code=true", "code=private")
            ),
            None
        );
        assert_eq!(login_url(Provider::Codex, &local), None);
    }

    // "Claude's sign-in takes a pasted code while it waits on the browser, and says when one fails"
    #[test]
    fn claudes_sign_in_takes_a_pasted_code_and_says_when_one_fails() {
        assert_eq!(
            login_observation(
                Provider::Claude,
                "\u{0004}\u{0008}\u{0008}Opening browser to sign in\u{2026}"
            ),
            Some(LoginObservation {
                code_entry: true,
                ..LoginObservation::awaiting_browser()
            })
        );
        assert_eq!(
            login_observation(Provider::Claude, "Paste code here if prompted > "),
            Some(LoginObservation {
                code_entry: true,
                ..LoginObservation::awaiting_browser()
            })
        );
        let invalid = login_observation(
            Provider::Claude,
            "Invalid code. Please make sure the full code was copied.",
        )
        .unwrap_or_default();
        assert!(invalid.code_entry);
        assert!(invalid.message.unwrap_or_default().contains("didn't work"));
        assert!(
            login_observation(Provider::Claude, "Paste authorization code:")
                .is_some_and(|observation| observation.manual_required)
        );
    }

    // "device codes and fixed prompts can be relayed while arbitrary diagnostics remain private"
    #[test]
    fn device_codes_and_fixed_prompts_are_relayed_while_diagnostics_stay_private() {
        assert_eq!(
            login_observation(Provider::Codex, "Enter code: ABCD-12345"),
            Some(LoginObservation {
                state: Some(LoginState::AwaitingCodeEntry),
                user_code: Some("ABCD-12345".into()),
                ..Default::default()
            })
        );
        let enter = login_observation(
            Provider::Claude,
            "Press Enter to continue. Account-specific diagnostic data",
        )
        .unwrap_or_default();
        assert!(enter.enter);
        assert_eq!(enter.state, Some(LoginState::AwaitingInput));
        assert!(
            login_observation(Provider::Claude, "Paste authorization code: private-value")
                .is_some_and(|observation| observation.manual_required)
        );
        assert!(
            login_observation(Provider::OpenCode, "API key:")
                .is_some_and(|observation| observation.manual_required)
        );
        assert_eq!(
            login_observation(Provider::Codex, "access_token=sk-SYNTHETIC0123456789"),
            None
        );
        assert_eq!(
            login_observation(Provider::Claude, "Error: the CLI said something private"),
            None
        );
    }

    // "Google authorization challenges belong only to ACP sign-in and never carry tokens"
    #[test]
    fn google_challenges_belong_only_to_acp_sign_in_and_never_carry_tokens() {
        let url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic&response_type=code&access_type=offline&prompt=consent";
        assert_eq!(login_url(Provider::Antigravity, url), Some(url.into()));
        assert_eq!(login_url(Provider::Acp, url), Some(url.into()));
        assert_eq!(login_url(Provider::OpenCode, url), None);
        assert_eq!(
            login_url(Provider::Acp, &format!("{url}&access_token=private-value")),
            None
        );
        assert_eq!(
            login_url(
                Provider::Acp,
                &url.replace("accounts.google.com", "accounts.google.com.evil.test")
            ),
            None
        );
    }

    // "ACP bridges can relay reviewed vendor sign-in links without exposing credentials"
    #[test]
    fn acp_bridges_relay_reviewed_vendor_links_without_credentials() {
        for url in [
            "https://claude.ai/oauth/authorize?client_id=synthetic&code_challenge=public-pkce",
            "https://cursor.com/loginDeepControl?uuid=synthetic&challenge=public-pkce&redirectTarget=sdk",
        ] {
            let observation =
                login_observation(Provider::Acp, &format!("Continue at {url}")).unwrap_or_default();
            assert_eq!(observation.state, Some(LoginState::AwaitingBrowser));
            assert_eq!(observation.url.as_deref(), Some(url));
            assert_eq!(
                login_observation(
                    Provider::Acp,
                    &format!("Continue at {url}&access_token=private-value")
                ),
                None
            );
        }
        assert_eq!(
            login_url(
                Provider::Acp,
                "https://cursor.com/loginDeepControl?redirectTarget=private-destination"
            ),
            None
        );
    }

    // "Pi relays reviewed SDK challenges while tokens and unrelated upstreams stay private"
    #[test]
    fn pi_relays_reviewed_sdk_challenges_while_tokens_stay_private() {
        let browser = "https://claude.ai/oauth/authorize?code=true&client_id=synthetic&scope=profile&state=public-pkce&redirect_uri=http%3A%2F%2Flocalhost%3A12345%2Fcallback";
        for url in [
            browser,
            "https://auth.openai.com/codex/device",
            "https://github.com/login/device",
        ] {
            assert_eq!(login_url(Provider::Pi, url), Some(url.into()));
            let separator = if url.contains('?') { "&" } else { "?" };
            assert_eq!(
                login_url(
                    Provider::Pi,
                    &format!("{url}{separator}access_token=private-value")
                ),
                None
            );
        }
        assert_eq!(
            login_url(
                Provider::Pi,
                &browser.replace("code=true", "code=private-authorization")
            ),
            None
        );
        assert_eq!(
            login_url(
                Provider::Pi,
                "https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic"
            ),
            None
        );
    }

    // "Codex's native one-time prompt accepts its bounded code after expiry instructions"
    #[test]
    fn codexs_native_one_time_prompt_accepts_its_bounded_code_after_expiry_instructions() {
        assert_eq!(
            login_observation(
                Provider::Codex,
                "2. Enter this one-time code (expires in 15 minutes)\n   ABCD-2048"
            ),
            Some(LoginObservation {
                state: Some(LoginState::AwaitingCodeEntry),
                user_code: Some("ABCD-2048".into()),
                ..Default::default()
            })
        );
    }

    // "only complete reviewed device instructions enable the following standalone code line"
    #[test]
    fn only_complete_reviewed_device_instructions_enable_a_standalone_code_line() {
        assert!(login_device_code_prompt(
            "2. Enter this one-time code (expires in 15 minutes)"
        ));
        assert!(login_device_code_prompt("Enter code:"));
        assert!(!login_device_code_prompt("Paste authorization code:"));
        assert!(!login_device_code_prompt("Access token: ABCD-2048"));
        assert!(!login_device_code_prompt(
            "An unknown diagnostic includes device code: private text"
        ));
    }
}
