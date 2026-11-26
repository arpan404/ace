// SPDX-License-Identifier: Apache-2.0
//! The configuration's TypeScript cases: `config-ace-client.test.ts` and the
//! schema refusals the environment gives.

use std::path::Path;

use super::parse::{parse_byte_size, web_origins};
use super::*;

fn read(pairs: &[(&str, &str)]) -> Result<Config, ConfigError> {
    super::read(&Env::from_pairs(pairs), Path::new("/tmp"))
}

/// `config-ace-client.test.ts`: "names a released daemon by its version, beta
/// prerelease included".
#[test]
fn a_released_daemon_is_named_by_its_version_beta_prerelease_included() {
    assert_eq!(
        ace_client_name("0.0.24-beta.1"),
        Some("daemon/0.0.24-beta.1".to_owned())
    );
    assert_eq!(ace_client_name("0.0.24"), Some("daemon/0.0.24".to_owned()));
}

/// `config-ace-client.test.ts`: "names a daemon run without a version a
/// development build".
#[test]
fn a_daemon_run_without_a_version_is_a_development_build() {
    assert_eq!(
        ace_client_name("development"),
        Some("daemon/development".to_owned())
    );
    let config = read(&[("ACE_HOME", "/tmp/ace-home")]);
    let Ok(config) = config else {
        panic!("a home and no version is a valid environment");
    };
    assert_eq!(config.ace_client.as_deref(), Some("daemon/development"));
}

/// `config-ace-client.test.ts`: "sends no name for a version it can't read
/// rather than misnaming itself".
#[test]
fn a_version_it_cannot_read_sends_no_name() {
    assert_eq!(ace_client_name("not a version"), None);
    assert_eq!(ace_client_name("1.2"), None);
    assert_eq!(ace_client_name("1.2.3-BETA"), None);
}

/// `readConfig`: `ACE_PORT` defaults to 4242 and the remote port follows it.
#[test]
fn the_default_port_is_4242_and_the_remote_port_follows_it() {
    let Ok(config) = read(&[]) else {
        panic!("an empty environment is valid");
    };
    assert_eq!(config.port, 4242);
    assert_eq!(config.remote_port, 4243);
    assert_eq!(config.listen, Listen::Local);
    assert_eq!(config.log_level, LogLevel::Info);
}

/// A port of 0 or 65535 leaves no room for `port + 1`: the remote port is 0.
#[test]
fn a_port_at_the_range_ends_gives_the_remote_listener_port_zero() {
    for port in ["0", "65535"] {
        let Ok(config) = read(&[("ACE_PORT", port)]) else {
            panic!("{port} is a port");
        };
        assert_eq!(config.remote_port, 0);
    }
    let Ok(config) = read(&[("ACE_PORT", "0"), ("ACE_REMOTE_PORT", "9000")]) else {
        panic!("an explicit remote port wins");
    };
    assert_eq!(config.remote_port, 9000);
}

/// `ACE_HOME` wins; without it the home is `~/.ace`.
#[test]
fn the_data_home_is_ace_home_or_the_users_dot_ace() {
    let Ok(config) = read(&[("ACE_HOME", "/var/ace-test")]) else {
        panic!("an absolute ACE_HOME is valid");
    };
    assert_eq!(config.data_dir, Path::new("/var/ace-test"));
    let Ok(config) = read(&[]) else {
        panic!("no ACE_HOME is valid");
    };
    assert_eq!(config.data_dir, Path::new("/tmp").join(".ace"));
}

/// The schema's refusals, variable by variable.
#[test]
fn the_environment_is_refused_where_the_schema_refuses_it() {
    let cases: &[(&str, &str, &str)] = &[
        ("ACE_PORT", "not-a-port", "ACE_PORT"),
        ("ACE_PORT", "70000", "ACE_PORT"),
        ("ACE_PORT", "1.5", "ACE_PORT"),
        ("ACE_LISTEN", "everywhere", "ACE_LISTEN"),
        ("ACE_LOG_LEVEL", "verbose", "ACE_LOG_LEVEL"),
        ("ACE_SAFE_MODE", "2", "ACE_SAFE_MODE"),
        ("ACE_LOG_MAX_BYTES", "banana", "ACE_LOG_MAX_BYTES"),
        ("ACE_LOG_MAX_BYTES", "1024", "ACE_LOG_MAX_BYTES"),
        ("ACE_RETENTION_DAYS", "0", "ACE_RETENTION_DAYS"),
        ("ACE_RETENTION_DAYS", "5000", "ACE_RETENTION_DAYS"),
        (
            "ACE_WORKTREE_PREPARATION_TIMEOUT_MS",
            "1000",
            "ACE_WORKTREE_PREPARATION_TIMEOUT_MS",
        ),
        (
            "ACE_PROVIDER_IDLE_SECONDS",
            "90000",
            "ACE_PROVIDER_IDLE_SECONDS",
        ),
        ("ACE_WEB_ORIGINS", "not-an-origin", "ACE_WEB_ORIGINS"),
        ("ACE_ACCOUNT_URL", "ftp://example.com", "ACE_ACCOUNT_URL"),
        ("ACE_RELAY_URL", "not-a-url", "ACE_RELAY_URL"),
        (
            "ACE_PUSH_GATEWAY_URL",
            "http://example.com",
            "ACE_PUSH_GATEWAY_URL",
        ),
    ];
    for (name, value, refused) in cases {
        match read(&[(name, value)]) {
            Ok(_) => panic!("{name}={value} must be refused"),
            Err(error) => assert_eq!(error.variable, *refused, "{name}={value}"),
        }
    }
}

/// `parseByteSize`: `1g`, `512m` and plain bytes, and nothing unreadable.
#[test]
fn a_log_size_is_read_as_bytes() {
    assert_eq!(parse_byte_size("1g"), Some(1024 * 1024 * 1024));
    assert_eq!(parse_byte_size("512m"), Some(512 * 1024 * 1024));
    assert_eq!(parse_byte_size("1048576"), Some(1_048_576));
    assert_eq!(parse_byte_size("10 MiB"), Some(10 * 1024 * 1024));
    assert_eq!(parse_byte_size("banana"), None);
    assert_eq!(parse_byte_size(""), None);
}

/// Web origins: comma separated, trimmed, at most 32.
#[test]
fn web_origins_are_trimmed_and_bounded() {
    assert_eq!(
        web_origins("http://localhost:5173, https://app.example.com").unwrap_or_default(),
        vec![
            "http://localhost:5173".to_owned(),
            "https://app.example.com".to_owned()
        ]
    );
    assert!(web_origins("https://example.com/path").is_err());
}
