// SPDX-License-Identifier: Apache-2.0
//! The policy a relayed dedicated channel follows (`apps/daemon/src/services/relay-channel.ts`,
//! `relay-attachments.ts`): which service a channel kind attaches, what each answers when its
//! service is missing or the credential lacks admin, the two backpressure budgets (256 KiB for
//! control, 1 MiB for file chunks), and the refusals in their words. The services behind it are
//! their owners'; this is the boundary the relay channel applies before any of them runs.

use ace_auth::Scope;
use ace_auth::devices::allows_scopes;
use ace_auth::devices_channel::{DEVICE_ACCESS_REFUSED, DEVICES_UNAVAILABLE, DeviceFailure};

/// A relay channel's kind, from the hello's `channel`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelKind {
    Files,
    Devices,
    Browser,
    Screen,
    ProviderAuth,
}

impl ChannelKind {
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "files" => Self::Files,
            "devices" => Self::Devices,
            "browser" => Self::Browser,
            "screen" => Self::Screen,
            "provider_auth" => Self::ProviderAuth,
            _ => return None,
        })
    }
}

/// Which services this daemon has published right now.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RelayServices {
    pub devices: bool,
    pub browser: bool,
    pub screen: bool,
    /// The provider-login sessions a `provider_auth` channel drives.
    pub provider_login: bool,
}

/// The service a channel attaches, or why it can't.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Attachment {
    ProviderAuth,
    /// The devices service, or the refusal each request is answered with.
    Devices {
        refusal: Option<DeviceFailure>,
    },
    Browser,
    Screen,
    Files,
}

/// A channel's attachment. A devices channel with no service or no admin is still opened: every
/// request is answered with why, rather than closing the channel without a word.
pub fn attach(
    kind: ChannelKind,
    services: RelayServices,
    scopes: &[Scope],
) -> Result<Attachment, &'static str> {
    let admin = allows_scopes(scopes, Scope::Admin);
    match kind {
        ChannelKind::ProviderAuth => Ok(Attachment::ProviderAuth),
        ChannelKind::Devices => {
            let refusal = if !services.devices {
                Some(DEVICES_UNAVAILABLE)
            } else if !admin {
                Some(DEVICE_ACCESS_REFUSED)
            } else {
                None
            };
            Ok(Attachment::Devices { refusal })
        }
        ChannelKind::Browser => {
            if services.browser {
                Ok(Attachment::Browser)
            } else {
                Err("Browser relay unavailable")
            }
        }
        ChannelKind::Screen => {
            if services.screen && admin {
                Ok(Attachment::Screen)
            } else {
                Err("Screen relay requires admin access")
            }
        }
        ChannelKind::Files => Ok(Attachment::Files),
    }
}

/// The control budget: a channel whose queue passed it closes (`relay-channel.ts:88`).
pub const CONTROL_BUDGET: usize = 256 * 1024;
/// File chunks' own budget, so an attachment backlog waits its turn (`:254`).
pub const CHUNK_BUDGET: usize = 1024 * 1024;

/// Whether another control message may be queued at this buffered size.
pub fn control_room(buffered: usize) -> bool {
    buffered <= CONTROL_BUDGET
}

pub fn chunk_room(buffered: usize) -> bool {
    buffered <= CHUNK_BUDGET
}

/// A send's refusal when the queue is full; each caller names its own failure.
pub const CONTROL_BACKPRESSURE: &str = "Relay control backpressure";
pub const ATTACHMENT_BACKPRESSURE: &str = "Attachment relay backpressure";

/// What a `devices.request`/`devices.ack` is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DevicesInput {
    Ack,
    Request,
}

impl DevicesInput {
    pub fn parse(message_type: &str) -> Result<Self, &'static str> {
        match message_type {
            "devices.ack" => Ok(Self::Ack),
            "devices.request" => Ok(Self::Request),
            _ => Err("Unexpected devices relay request"),
        }
    }
}

/// What a `screen.request`/`screen.ack` is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenInput {
    Ack,
    Request,
}

impl ScreenInput {
    pub fn parse(message_type: &str) -> Result<Self, &'static str> {
        match message_type {
            "screen.ack" => Ok(Self::Ack),
            "screen.request" => Ok(Self::Request),
            _ => Err("Screen access denied"),
        }
    }
}

/// Binary input: only a files channel takes it, and only for its legacy stream.
pub fn binary_input(kind: ChannelKind, has_legacy_files: bool) -> Result<(), &'static str> {
    match kind {
        ChannelKind::Devices => Err("Device relay does not accept input binary data"),
        ChannelKind::Browser => Err("Browser relay does not accept binary input"),
        ChannelKind::Screen => Err("Screen relay does not accept binary input"),
        ChannelKind::ProviderAuth => Err("Provider auth relay does not accept binary input"),
        ChannelKind::Files => {
            if has_legacy_files {
                Ok(())
            } else {
                Err("Legacy files unavailable")
            }
        }
    }
}

/// Files requests that need a thread: without the scoped chunk channel they are refused, and a
/// request that names no thread in the legacy channel is refused too.
pub fn files_need_scoped(channel_has_thread: bool, workspace: bool, support: bool) -> bool {
    channel_has_thread || workspace || support
}

/// The support-scope operations that only a local caller may run (`relay-channel.ts:301`).
pub fn support_local_only(operation: &str, include_threads: bool, artifact_id: &str) -> bool {
    match operation {
        "artifact.support" => include_threads,
        "artifact.download" => artifact_id.starts_with("local-support-"),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    //! `services/relay-channel.ts` has no test file of its own; these pin the policy it applies
    //! and the words it refuses with.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use ace_auth::Scope;
    use ace_auth::devices_channel::{DEVICE_ACCESS_REFUSED, DEVICES_UNAVAILABLE};

    use super::{
        ATTACHMENT_BACKPRESSURE, Attachment, CHUNK_BUDGET, CONTROL_BACKPRESSURE, CONTROL_BUDGET,
        ChannelKind, DevicesInput, RelayServices, ScreenInput, attach, binary_input, chunk_room,
        control_room, files_need_scoped, support_local_only,
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
            "Provider auth relay does not accept binary input"
        );
    }

    #[test]
    fn scoped_file_requests_need_a_thread_and_support_exports_stay_local() {
        assert!(!files_need_scoped(false, false, false));
        assert!(files_need_scoped(true, false, false));
        assert!(files_need_scoped(false, true, false));
        assert!(files_need_scoped(false, false, true));
        assert!(!support_local_only("artifact.support", false, "id"));
        assert!(support_local_only("artifact.support", true, "id"));
        assert!(support_local_only(
            "artifact.download",
            false,
            "local-support-1"
        ));
        assert!(!support_local_only(
            "artifact.download",
            false,
            "artifact-1"
        ));
    }
}
