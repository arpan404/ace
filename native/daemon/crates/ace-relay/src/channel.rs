// SPDX-License-Identifier: Apache-2.0
//! The policy a relayed dedicated channel follows (`apps/daemon/src/services/relay-channel.ts`,
//! `relay-attachments.ts`): which service a channel kind attaches, what each answers when its
//! service is missing or the credential lacks admin, the two backpressure budgets (256 KiB for
//! control, 1 MiB for file chunks), and the refusals in their words. The services behind it are
//! their owners'; this is the boundary the relay channel applies before any of them runs.

use ace_auth::Scope;
use ace_auth::devices::allows_scopes;
use ace_auth::devices_channel::{DeviceFailure, DevicesChannel};

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
        ChannelKind::Devices => Ok(Attachment::Devices {
            // One home for the decision, with the TypeScript's precedence (a missing service is
            // answered before a missing scope).
            refusal: DevicesChannel::refusal(services.devices, scopes),
        }),
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
        ChannelKind::ProviderAuth => Err("Provider auth has no binary input"),
        ChannelKind::Files => {
            if has_legacy_files {
                Ok(())
            } else {
                Err("Legacy files unavailable")
            }
        }
    }
}

/// The support-scope operations that only a local caller may run (`relay-channel.ts:301`).
pub fn support_local_only(
    operation: &str,
    include_threads: bool,
    artifact_id: &str,
) -> Result<(), &'static str> {
    let refused = match operation {
        "artifact.support" => include_threads,
        "artifact.download" => artifact_id.starts_with("local-support-"),
        _ => true,
    };
    if refused {
        Err("Conversation export requires local access")
    } else {
        Ok(())
    }
}

/// Whether a files message goes to the scoped chunk channel rather than the legacy one
/// (`relay-channel.ts:310`-`:317`).
pub fn files_routes_to_scoped(
    message_type: &str,
    names_thread: bool,
    names_workspace: bool,
    support: bool,
    channel: Option<i64>,
) -> bool {
    match message_type {
        "files.abort" | "files.pull" | "files.chunk" => true,
        "files.request" => names_thread || names_workspace || support,
        "files.cancel" => channel.is_some_and(|channel| channel > 0x8000_0000),
        _ => false,
    }
}

#[cfg(test)]
mod tests;
