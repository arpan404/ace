//! `services/relay-channel.ts` has no test file of its own; these pin the policy it applies
//! and the words it refuses with.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use ace_auth::Scope;
use ace_auth::devices_channel::{DEVICE_ACCESS_REFUSED, DEVICES_UNAVAILABLE};

use super::{
    ATTACHMENT_BACKPRESSURE, Attachment, CHUNK_BUDGET, CONTROL_BACKPRESSURE, CONTROL_BUDGET,
    ChannelKind, DevicesInput, RelayServices, ScreenInput, attach, binary_input, chunk_room,
    control_room, files_routes_to_scoped, support_local_only,
};

const ALL: RelayServices = RelayServices {
    devices: true,
    browser: true,
    screen: true,
    provider_login: true,
};

#[test]
fn every_kind_attaches_its_service_and_a_missing_one_is_refused_in_its_own_words() {
    assert_eq!(
        attach(ChannelKind::Files, ALL, &[Scope::Read]).unwrap(),
        Attachment::Files
    );
    assert_eq!(
        attach(ChannelKind::ProviderAuth, ALL, &[Scope::Operate]).unwrap(),
        Attachment::ProviderAuth
    );
    assert_eq!(
        attach(ChannelKind::Browser, ALL, &[Scope::Read]).unwrap(),
        Attachment::Browser
    );
    assert_eq!(
        attach(ChannelKind::Screen, ALL, &[Scope::Admin]).unwrap(),
        Attachment::Screen
    );
    assert_eq!(
        attach(
            ChannelKind::Browser,
            RelayServices {
                browser: false,
                ..ALL
            },
            &[Scope::Admin]
        )
        .unwrap_err(),
        "Browser relay unavailable"
    );
    assert_eq!(
        attach(
            ChannelKind::Screen,
            RelayServices {
                screen: false,
                ..ALL
            },
            &[Scope::Admin]
        )
        .unwrap_err(),
        "Screen relay requires admin access"
    );
    assert_eq!(
        attach(ChannelKind::Screen, ALL, &[Scope::Read]).unwrap_err(),
        "Screen relay requires admin access"
    );
}

#[test]
fn a_devices_channel_answers_its_refusals_instead_of_closing() {
    assert_eq!(
        attach(ChannelKind::Devices, ALL, &[Scope::Admin]).unwrap(),
        Attachment::Devices { refusal: None }
    );
    assert_eq!(
        attach(ChannelKind::Devices, ALL, &[Scope::Read]).unwrap(),
        Attachment::Devices {
            refusal: Some(DEVICE_ACCESS_REFUSED)
        }
    );
    assert_eq!(
        attach(
            ChannelKind::Devices,
            RelayServices {
                devices: false,
                ..ALL
            },
            &[Scope::Admin]
        )
        .unwrap(),
        Attachment::Devices {
            refusal: Some(DEVICES_UNAVAILABLE)
        }
    );
    assert_eq!(DEVICE_ACCESS_REFUSED.code, "permission_denied");
    assert!(
        DEVICE_ACCESS_REFUSED
            .message
            .to_lowercase()
            .contains("admin")
    );
    assert_eq!(DEVICES_UNAVAILABLE.code, "not_supported");
    assert!(
        DEVICES_UNAVAILABLE
            .message
            .to_lowercase()
            .contains("unavailable")
    );
}

#[test]
fn the_two_budgets_admit_at_the_bound_and_close_past_it() {
    assert!(control_room(CONTROL_BUDGET));
    assert!(!control_room(CONTROL_BUDGET + 1));
    assert!(chunk_room(CHUNK_BUDGET));
    assert!(!chunk_room(CHUNK_BUDGET + 1));
    assert_eq!(CONTROL_BACKPRESSURE, "Relay control backpressure");
    assert_eq!(ATTACHMENT_BACKPRESSURE, "Attachment relay backpressure");
}

#[test]
fn each_channel_answers_only_its_own_requests() {
    assert_eq!(DevicesInput::parse("devices.ack"), Ok(DevicesInput::Ack));
    assert_eq!(
        DevicesInput::parse("devices.request"),
        Ok(DevicesInput::Request)
    );
    assert_eq!(
        DevicesInput::parse("files.request").unwrap_err(),
        "Unexpected devices relay request"
    );
    assert_eq!(ScreenInput::parse("screen.ack"), Ok(ScreenInput::Ack));
    assert_eq!(
        ScreenInput::parse("screen.request"),
        Ok(ScreenInput::Request)
    );
    assert_eq!(
        ScreenInput::parse("devices.request").unwrap_err(),
        "Screen access denied"
    );
}

#[test]
fn binary_input_is_taken_only_by_the_files_channel() {
    assert_eq!(binary_input(ChannelKind::Files, true), Ok(()));
    assert_eq!(
        binary_input(ChannelKind::Files, false).unwrap_err(),
        "Legacy files unavailable"
    );
    assert_eq!(
        binary_input(ChannelKind::Devices, true).unwrap_err(),
        "Device relay does not accept input binary data"
    );
    assert_eq!(
        binary_input(ChannelKind::Browser, true).unwrap_err(),
        "Browser relay does not accept binary input"
    );
    assert_eq!(
        binary_input(ChannelKind::Screen, true).unwrap_err(),
        "Screen relay does not accept binary input"
    );
    assert_eq!(
        binary_input(ChannelKind::ProviderAuth, true).unwrap_err(),
        "Provider auth has no binary input"
    );
}

#[test]
fn files_routing_and_support_exports_follow_the_typescript_conditions() {
    assert!(files_routes_to_scoped(
        "files.abort",
        false,
        false,
        false,
        None
    ));
    assert!(files_routes_to_scoped(
        "files.pull",
        false,
        false,
        false,
        None
    ));
    assert!(files_routes_to_scoped(
        "files.chunk",
        false,
        false,
        false,
        None
    ));
    assert!(files_routes_to_scoped(
        "files.request",
        true,
        false,
        false,
        None
    ));
    assert!(files_routes_to_scoped(
        "files.request",
        false,
        true,
        false,
        None
    ));
    assert!(files_routes_to_scoped(
        "files.request",
        false,
        false,
        true,
        None
    ));
    assert!(!files_routes_to_scoped(
        "files.request",
        false,
        false,
        false,
        None
    ));
    assert!(files_routes_to_scoped(
        "files.cancel",
        false,
        false,
        false,
        Some(0x8000_0001)
    ));
    assert!(!files_routes_to_scoped(
        "files.cancel",
        false,
        false,
        false,
        Some(0x8000_0000)
    ));
    assert_eq!(support_local_only("artifact.support", false, "id"), Ok(()));
    assert_eq!(
        support_local_only("artifact.support", true, "id"),
        Err("Conversation export requires local access")
    );
    assert_eq!(
        support_local_only("artifact.download", false, "local-support-1"),
        Err("Conversation export requires local access")
    );
    assert_eq!(
        support_local_only("artifact.download", false, "artifact-1"),
        Ok(())
    );
}

#[test]
fn an_account_channels_authority_is_its_admission_check_on_every_request() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::AccountChannels;

    let live = Arc::new(AtomicBool::new(true));
    let mut channels: AccountChannels<u64> = AccountChannels::new();
    let check = Arc::clone(&live);
    channels.watch(7, Box::new(move || check.load(Ordering::SeqCst)));
    // An account device holds admin for as long as it stays admitted, whatever scope is asked.
    assert_eq!(channels.authorizes(&7), Some(true));
    assert!(channels.lapsed().is_empty());
    // The account changes (a revocation, a lapsed grant, a left organization).
    live.store(false, Ordering::SeqCst);
    assert_eq!(
        channels.authorizes(&7),
        Some(false),
        "later traffic is refused by the same check"
    );
    assert_eq!(
        channels.lapsed(),
        vec![7],
        "the established channel is named for closing"
    );
    // A paired device's channel has no check and falls back to its stored scopes.
    assert_eq!(channels.authorizes(&8), None);
    channels.forget(&7);
    assert!(channels.is_empty());
}
