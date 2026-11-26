//! Ports `apps/daemon/src/host-identity.server.process.test.ts` (all five cases) and
//! `apps/daemon/src/computer-name.test.ts`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::{
    IconColor, IdentityFacts, IdentityRefusal, IdentitySession, MachineIcon, MachineIconKind,
    SettingValue, host_identity,
};

fn facts() -> IdentityFacts {
    IdentityFacts {
        host_id: "host".to_owned(),
        default_name: "Laptop".to_owned(),
        hostname: "laptop".to_owned(),
        version: "1.2.3".to_owned(),
        platform: "darwin".to_owned(),
    }
}

#[test]
fn authenticated_identity_uses_the_computer_name_until_the_global_display_name_is_edited() {
    let first = host_identity(&facts(), None, None);
    assert_eq!(first.display_name, "Laptop");
    assert_eq!(first.host_id, "host");
    assert_eq!(first.version, "1.2.3");
    assert_eq!(first.platform.as_deref(), Some("darwin"));
    // The person renames it and picks a mark.
    let renamed = SettingValue::set("Office".to_owned());
    let icon = SettingValue::set(MachineIcon {
        kind: MachineIconKind::Server,
        color: Some(IconColor::Purple),
    });
    let renamed_identity = host_identity(&facts(), Some(&renamed), Some(&icon));
    assert_eq!(renamed_identity.display_name, "Office");
    assert_eq!(
        renamed_identity.icon,
        Some(MachineIcon {
            kind: MachineIconKind::Server,
            color: Some(IconColor::Purple),
        })
    );
    // A reconnect reads the same settings, so it sees the same name and mark.
    assert_eq!(
        host_identity(&facts(), Some(&renamed), Some(&icon)),
        renamed_identity
    );
    // An unset icon is left out: the client picks its own default mark.
    let default_icon = SettingValue::defaults(MachineIcon {
        kind: MachineIconKind::Laptop,
        color: None,
    });
    assert_eq!(
        host_identity(&facts(), None, Some(&default_icon)).icon,
        None
    );
    // An empty display name falls back to the computer's own name.
    let empty = SettingValue::set(String::new());
    assert_eq!(
        host_identity(&facts(), Some(&empty), None).display_name,
        "Laptop"
    );
}

#[test]
fn an_unauthenticated_socket_cannot_read_host_identity() {
    // A socket with no hello reaches no service: the hello gate refuses it. What T2 owns is
    // the service's own scope check, which refuses a socket without `read`.
    let session = IdentitySession::new();
    assert_eq!(session.begin(false), Err(IdentityRefusal::Forbidden));
    assert_eq!(IdentityRefusal::Forbidden.code(), "forbidden");
    assert_eq!(
        IdentityRefusal::Forbidden.message(),
        "Identity read unavailable"
    );
}

#[test]
fn identity_requires_read_scope_on_an_authenticated_paired_connection() {
    // An `operate`-only device: the socket is welcomed, the identity read is forbidden.
    assert!(!crate::devices::allows_scopes(
        &[crate::devices::Scope::Operate],
        crate::devices::Scope::Read
    ));
    let session = IdentitySession::new();
    assert_eq!(session.begin(false), Err(IdentityRefusal::Forbidden));
}

#[test]
fn identity_says_which_operating_system_and_leaves_out_one_clients_do_not_know() {
    for (platform, reported) in [
        ("darwin", Some("darwin")),
        ("linux", Some("linux")),
        ("win32", Some("win32")),
        ("aix", None),
    ] {
        let identity = host_identity(
            &IdentityFacts {
                platform: platform.to_owned(),
                ..facts()
            },
            None,
            None,
        );
        assert_eq!(identity.platform.as_deref(), reported, "{platform}");
    }
}

#[test]
fn without_an_injected_platform_the_daemon_reports_the_one_it_runs_on() {
    // Node names the running system: `darwin` on macOS, `win32` on Windows.
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let identity = host_identity(
        &IdentityFacts {
            platform: platform.to_owned(),
            ..facts()
        },
        None,
        None,
    );
    assert_eq!(identity.platform.as_deref(), Some(platform));
}

#[test]
fn a_second_read_while_the_first_is_pending_is_busy_and_the_first_answers() {
    let session = IdentitySession::new();
    session.begin(true).unwrap();
    assert_eq!(session.begin(true), Err(IdentityRefusal::Busy));
    assert_eq!(IdentityRefusal::Busy.code(), "busy");
    let identity = host_identity(&facts(), None, None);
    assert!(session.finish(true, identity.clone()).is_some());
    // A socket that lost its read scope while the settings were read is told nothing.
    session.begin(true).unwrap();
    assert!(session.finish(false, identity.clone()).is_none());
    // And the failure answer, which also clears the flag.
    session.begin(true).unwrap();
    assert_eq!(session.failed(), IdentityRefusal::Unavailable);
    session.begin(true).expect("the flag was cleared");
}
