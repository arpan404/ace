// SPDX-License-Identifier: Apache-2.0
//! The devices channel's session side (`apps/daemon/src/services/devices.ts:149`–`:265`): which
//! credential opens it, the two refusals every client shows (`services/device-refusals.ts`), the
//! order a welcomed channel speaks in, and acks. The device work behind it is `@ace/devices`'
//! own; this is the daemon's authorization boundary around it.

use crate::devices::Scope;

/// Why a devices request is refused, in the words every client shows (`device-refusals.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeviceFailure {
    pub code: &'static str,
    pub message: &'static str,
    pub hint: &'static str,
}

/// The credential holds no `admin` scope: refused before any device work starts.
pub const DEVICE_ACCESS_REFUSED: DeviceFailure = DeviceFailure {
    code: "permission_denied",
    message: "Administrator scope is required for device access",
    hint: "Connect with an administrator device credential to use Devices.",
};

/// This daemon has no devices service (or it is still loading): answered at once, never left
/// waiting on a list that won't come.
pub const DEVICES_UNAVAILABLE: DeviceFailure = DeviceFailure {
    code: "not_supported",
    message: "Devices service is unavailable on this daemon",
    hint: "Check the daemon's device service and reconnect.",
};

/// What opening the channel did when the socket authenticated (`authenticated`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelOpening {
    /// The service was already loaded: the channel is open before the welcome.
    Opened,
    /// The service loads on first use; the channel opens when it exists.
    WaitingForService,
    /// Not this credential, or not this channel.
    Closed,
}

/// What a channel forwards to its service.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Request {
    /// Hand the message to the devices service and answer with its result.
    Forward,
}

/// The first frame a welcomed channel sends, before anything it subscribed to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelFrame {
    DevicesEnabled { enabled: bool },
}

/// One socket's devices channel (`createDevicesSession`).
#[derive(Debug, Clone, Default)]
pub struct DevicesChannel {
    opened: bool,
    waiting: bool,
    welcomed: bool,
    closed: bool,
}

impl DevicesChannel {
    pub fn new() -> Self {
        Self::default()
    }

    /// The hello's `channel`: only the main channel or `devices`, and only a credential with
    /// `admin`. A channel opened before the welcome activates on it, so a full subscriber budget
    /// refuses the hello as over limit instead of leaving a silent channel.
    pub fn authenticated(
        &mut self,
        channel: Option<&str>,
        scopes: &[Scope],
        service_loaded: bool,
    ) -> ChannelOpening {
        if self.closed || !matches!(channel, None | Some("devices")) {
            return ChannelOpening::Closed;
        }
        if !allows_admin(scopes) {
            return ChannelOpening::Closed;
        }
        if service_loaded {
            self.opened = true;
            ChannelOpening::Opened
        } else {
            self.waiting = true;
            ChannelOpening::WaitingForService
        }
    }

    /// The devices service finished loading: the waiting channel opens.
    pub fn service_loaded(&mut self, scopes: &[Scope]) -> bool {
        if self.closed || self.opened || !self.waiting || !allows_admin(scopes) {
            return false;
        }
        self.waiting = false;
        self.opened = true;
        true
    }

    /// The client has its welcome: tell it whether devices are on, then anything that changed
    /// since the channel subscribed. Nothing is pushed before the welcome.
    pub fn welcomed(&mut self, enabled: bool) -> Option<ChannelFrame> {
        self.welcomed = true;
        if self.closed || !self.opened {
            return None;
        }
        Some(ChannelFrame::DevicesEnabled { enabled })
    }

    /// The refusal a request gets, without opening a channel (`relay-channel.ts:94`-`:99`):
    /// a missing service wins over a missing admin scope.
    pub fn refusal(service_loaded: bool, scopes: &[Scope]) -> Option<DeviceFailure> {
        if !service_loaded {
            return Some(DEVICES_UNAVAILABLE);
        }
        if !allows_admin(scopes) {
            return Some(DEVICE_ACCESS_REFUSED);
        }
        None
    }

    /// A `devices.request`. A refused request is always answered, so the client can say why
    /// instead of waiting; a refusal names the credential or the missing service.
    pub fn request(&self, scopes: &[Scope]) -> Result<Request, DeviceFailure> {
        if self.closed {
            return Err(DEVICES_UNAVAILABLE);
        }
        if !allows_admin(scopes) {
            return Err(DEVICE_ACCESS_REFUSED);
        }
        if !self.opened {
            return Err(DEVICES_UNAVAILABLE);
        }
        Ok(Request::Forward)
    }

    /// A `devices.ack`: fire and forget, and only while the credential still authorizes.
    pub fn ack(&self, scopes: &[Scope]) -> bool {
        !self.closed && self.opened && allows_admin(scopes)
    }

    pub fn close(&mut self) {
        self.closed = true;
        self.opened = false;
        self.waiting = false;
    }

    pub fn is_open(&self) -> bool {
        self.opened
    }

    pub fn is_waiting(&self) -> bool {
        self.waiting
    }
}

fn allows_admin(scopes: &[Scope]) -> bool {
    crate::devices::allows_scopes(scopes, Scope::Admin)
}

#[cfg(test)]
mod tests {
    //! Ports all four cases of `apps/daemon/src/devices-access.server.process.test.ts`.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::{
        ChannelFrame, ChannelOpening, DEVICE_ACCESS_REFUSED, DEVICES_UNAVAILABLE, DevicesChannel,
        Request,
    };
    use crate::devices::Scope;

    #[test]
    fn read_and_operate_channels_explain_administrator_refusals_without_waiting() {
        for scope in [Scope::Read, Scope::Operate] {
            let mut channel = DevicesChannel::new();
            // The hello is welcomed, but this credential opens no devices channel.
            assert_eq!(
                channel.authenticated(Some("devices"), &[scope], true),
                ChannelOpening::Closed
            );
            assert!(channel.welcomed(true).is_none());
            // Both operations the process test asks are answered, never left pending.
            let refusal = channel.request(&[scope]).unwrap_err();
            assert_eq!(refusal, DEVICE_ACCESS_REFUSED);
            assert_eq!(refusal.code, "permission_denied");
            assert!(refusal.message.to_lowercase().contains("admin"));
            assert!(refusal.hint.to_lowercase().contains("admin"));
            // Nothing was enabled, and acks carry no authority either.
            assert!(!channel.is_open());
            assert!(!channel.ack(&[scope]));
        }
    }

    #[test]
    fn an_administrator_loads_and_enables_devices_on_the_same_boundary() {
        let mut channel = DevicesChannel::new();
        assert_eq!(
            channel.authenticated(Some("devices"), &[Scope::Admin], true),
            ChannelOpening::Opened
        );
        assert_eq!(
            channel.welcomed(true),
            Some(ChannelFrame::DevicesEnabled { enabled: true })
        );
        assert_eq!(channel.request(&[Scope::Admin]), Ok(Request::Forward));
        assert!(channel.ack(&[Scope::Admin]));
    }

    #[test]
    fn an_unavailable_devices_service_answers_at_once() {
        let mut channel = DevicesChannel::new();
        assert_eq!(
            channel.authenticated(Some("devices"), &[Scope::Admin], false),
            ChannelOpening::WaitingForService
        );
        assert!(channel.is_waiting());
        let refusal = channel.request(&[Scope::Admin]).unwrap_err();
        assert_eq!(refusal, DEVICES_UNAVAILABLE);
        assert_eq!(refusal.code, "not_supported");
        assert!(refusal.message.to_lowercase().contains("unavailable"));
        // A non-admin is told the credential is the problem, service or no service.
        assert_eq!(
            channel.request(&[Scope::Read]).unwrap_err(),
            DEVICE_ACCESS_REFUSED
        );
    }

    #[test]
    fn a_loaded_service_opens_before_the_welcome_and_is_enabled_first() {
        let mut channel = DevicesChannel::new();
        // The channel opens at authentication, so a full subscriber budget can refuse the hello.
        assert_eq!(
            channel.authenticated(Some("devices"), &[Scope::Admin], true),
            ChannelOpening::Opened
        );
        // Nothing is pushed before the welcome; the first frame after it says whether devices
        // are on.
        assert_eq!(
            channel.welcomed(false),
            Some(ChannelFrame::DevicesEnabled { enabled: false })
        );
        channel.close();
        assert!(channel.welcomed(true).is_none());
    }

    #[test]
    fn a_channel_waits_for_the_service_then_activates_on_the_welcome() {
        let mut channel = DevicesChannel::new();
        assert_eq!(
            channel.authenticated(Some("devices"), &[Scope::Admin], false),
            ChannelOpening::WaitingForService
        );
        assert!(channel.service_loaded(&[Scope::Admin]));
        assert!(channel.is_open());
        assert_eq!(channel.request(&[Scope::Admin]), Ok(Request::Forward));
    }

    #[test]
    fn only_the_main_channel_or_devices_opens() {
        for channel_name in [None, Some("devices")] {
            let mut channel = DevicesChannel::new();
            assert_eq!(
                channel.authenticated(channel_name, &[Scope::Admin], true),
                ChannelOpening::Opened
            );
        }
        for channel_name in [Some("files"), Some("screen"), Some("media")] {
            let mut channel = DevicesChannel::new();
            assert_eq!(
                channel.authenticated(channel_name, &[Scope::Admin], true),
                ChannelOpening::Closed
            );
        }
    }
}
