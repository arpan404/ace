// SPDX-License-Identifier: Apache-2.0
//! The environment's individual readers, each one a schema rule from
//! `apps/daemon/src/config.ts`.

use std::path::{Path, PathBuf};

use super::{ConfigError, Env, invalid, resolve};

/// A port: a whole number from 0 to 65535, coerced from text as Zod does.
pub(super) fn port(env: &Env, name: &'static str) -> Result<Option<u16>, ConfigError> {
    let Some(value) = env.get(name) else {
        return Ok(None);
    };
    let parsed = number(name, value)?;
    if parsed.fract() != 0.0 || !(0.0..=65535.0).contains(&parsed) {
        return Err(invalid(name, "expected a whole port from 0 to 65535"));
    }
    Ok(Some(parsed as u16))
}

/// `z.coerce.number()`: text read as a number; an empty value is 0.
pub(super) fn number(name: &'static str, value: &str) -> Result<f64, ConfigError> {
    let text = value.trim();
    if text.is_empty() {
        return Ok(0.0);
    }
    let parsed = text
        .parse::<f64>()
        .map_err(|_| invalid(name, format!("expected a number, not {value}")))?;
    if !parsed.is_finite() {
        return Err(invalid(
            name,
            format!("expected a finite number, not {value}"),
        ));
    }
    Ok(parsed)
}

/// A whole number from `lowest` to `highest`.
pub(super) fn bounded(
    env: &Env,
    name: &'static str,
    lowest: i64,
    highest: i64,
) -> Result<Option<i64>, ConfigError> {
    let Some(value) = env.get(name) else {
        return Ok(None);
    };
    let parsed = number(name, value)?;
    if parsed.fract() != 0.0 || parsed < lowest as f64 || parsed > highest as f64 {
        return Err(invalid(
            name,
            format!("expected a whole number from {lowest} to {highest}"),
        ));
    }
    Ok(Some(parsed as i64))
}

/// `z.coerce.number().int().positive()`.
pub(super) fn positive(env: &Env, name: &'static str) -> Result<Option<i64>, ConfigError> {
    let Some(value) = env.get(name) else {
        return Ok(None);
    };
    let parsed = number(name, value)?;
    if parsed.fract() != 0.0 || parsed <= 0.0 || parsed > 9_007_199_254_740_991.0 {
        return Err(invalid(name, "expected a positive whole number"));
    }
    Ok(Some(parsed as i64))
}

/// `z.enum(["0", "1"])`, read as `value === "1"`.
pub(super) fn switch(env: &Env, name: &'static str) -> Result<bool, ConfigError> {
    match env.get(name) {
        None => Ok(false),
        Some("0") => Ok(false),
        Some("1") => Ok(true),
        Some(other) => Err(invalid(name, format!("expected 0 or 1, not {other}"))),
    }
}

/// `z.string().min(1).optional()`.
pub(super) fn non_empty(env: &Env, name: &'static str) -> Result<Option<String>, ConfigError> {
    match env.get(name) {
        None => Ok(None),
        Some("") => Err(invalid(name, "must not be empty")),
        Some(value) => Ok(Some(value.to_owned())),
    }
}

/// A configured path, resolved as `resolve()` does.
pub(super) fn path_value(env: &Env, name: &'static str) -> Result<Option<PathBuf>, ConfigError> {
    Ok(non_empty(env, name)?.map(|value| resolve(Path::new(&value))))
}

/// `parseByteSize` (`@ace/diagnostics/log-policy`): `1g`, `512m`, `1048576`.
pub(super) fn parse_byte_size(input: &str) -> Option<i64> {
    let text = input.trim().to_ascii_lowercase();
    let (number, unit) = if let Some(stripped) = text.strip_suffix("ib") {
        split_unit(stripped)
    } else if let Some(stripped) = text.strip_suffix('b') {
        split_unit(stripped)
    } else {
        split_unit(&text)
    };
    let digits = number.trim();
    if digits.is_empty() || digits.len() > 16 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let scale: i64 = match unit.trim() {
        "" => 1,
        "k" => 1024,
        "m" => 1024 * 1024,
        "g" => 1024 * 1024 * 1024,
        "t" => 1024_i64.pow(4),
        _ => return None,
    };
    let value = digits.parse::<i64>().ok()?.checked_mul(scale)?;
    Some(value)
}

/// A size splits into its digits and the unit letter that follows them.
fn split_unit(text: &str) -> (&str, &str) {
    let end = text
        .bytes()
        .position(|byte| !byte.is_ascii_digit() && byte != b' ')
        .unwrap_or(text.len());
    text.split_at(end)
}

/// `z.url()`: an absolute URL with a scheme and a host.
pub(super) fn absolute_url(name: &'static str, value: &str) -> Result<(), ConfigError> {
    let Some((scheme, rest)) = value.split_once("://") else {
        return Err(invalid(name, "expected a URL such as https://example.com"));
    };
    if scheme.is_empty()
        || !scheme
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
    {
        return Err(invalid(name, "expected a URL such as https://example.com"));
    }
    if rest.is_empty() || rest.chars().any(char::is_whitespace) {
        return Err(invalid(name, "expected a URL such as https://example.com"));
    }
    Ok(())
}

/// `AceAccountOrigin`: an exact HTTPS origin, or a loopback HTTP origin.
pub(super) fn account_origin(value: &str) -> Result<(), ConfigError> {
    let name = "ACE_ACCOUNT_URL";
    absolute_url(name, value)?;
    let loopback = value.starts_with("http://localhost")
        || value.starts_with("http://127.0.0.1")
        || value.starts_with("http://[::1]");
    if !value.starts_with("https://") && !loopback {
        return Err(invalid(
            name,
            "expected an HTTPS origin or a loopback HTTP origin",
        ));
    }
    if value.contains(['/', '?', '#', '@']) && !is_origin(value) {
        return Err(invalid(name, "expected an origin, with no path"));
    }
    Ok(())
}

/// `notifications.pushGatewayUrl`: HTTPS, or HTTP on 127.0.0.1.
pub(super) fn push_gateway(value: &str) -> Result<(), ConfigError> {
    let name = "ACE_PUSH_GATEWAY_URL";
    absolute_url(name, value)?;
    if value.starts_with("https://") {
        return Ok(());
    }
    if value.starts_with("http://127.0.0.1:") || value == "http://127.0.0.1" {
        return Ok(());
    }
    Err(invalid(name, "expected an HTTPS URL, or HTTP on 127.0.0.1"))
}

/// `ACE_WEB_ORIGINS`: comma-separated http(s) origins, at most 32.
pub(super) fn web_origins(value: &str) -> Result<Vec<String>, ConfigError> {
    let mut origins = Vec::new();
    for entry in value.split(',').map(str::trim).filter(|e| !e.is_empty()) {
        if !is_origin(entry) {
            return Err(invalid(
                "ACE_WEB_ORIGINS",
                "expected an http(s) origin such as http://localhost:5173",
            ));
        }
        origins.push(entry.to_owned());
    }
    if origins.len() > 32 {
        return Err(invalid("ACE_WEB_ORIGINS", "expected at most 32 origins"));
    }
    Ok(origins)
}

/// Whether `value` is exactly a scheme, host and optional port: no path.
fn is_origin(value: &str) -> bool {
    let Some((scheme, rest)) = value.split_once("://") else {
        return false;
    };
    if scheme != "http" && scheme != "https" {
        return false;
    }
    if rest.contains(['/', '?', '#', '@', ' ']) {
        return false;
    }
    // A port, when present, is digits only. An IPv6 host is bracketed.
    if let Some(bracketed) = rest.strip_prefix('[') {
        let Some((host, after)) = bracketed.split_once(']') else {
            return false;
        };
        return !host.is_empty()
            && (after.is_empty() || valid_port(&after[1..], after.starts_with(':')));
    }
    match rest.rsplit_once(':') {
        None => !rest.is_empty(),
        Some((host, port)) => !host.is_empty() && valid_port(port, true),
    }
}

/// A port after the colon: digits only, and the colon was there.
fn valid_port(port: &str, had_colon: bool) -> bool {
    had_colon && !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit())
}

/// `aceClientName("daemon", version)`: `daemon/<version>`, or none when unreadable.
pub fn ace_client_name(version: &str) -> Option<String> {
    if version == "development" {
        return Some("daemon/development".to_owned());
    }
    if !release_version(version) {
        return None;
    }
    Some(format!("daemon/{version}"))
}

/// `ReleaseVersion`'s pattern: `\d+\.\d+\.\d+(?:-[a-z0-9.]+)?`, at most 80 chars.
fn release_version(value: &str) -> bool {
    if value.len() > 80 {
        return false;
    }
    let (base, prerelease) = match value.split_once('-') {
        None => (value, None),
        Some((base, rest)) => (base, Some(rest)),
    };
    if let Some(prerelease) = prerelease
        && (prerelease.is_empty()
            || !prerelease
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.'))
    {
        return false;
    }
    let parts: Vec<&str> = base.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}
