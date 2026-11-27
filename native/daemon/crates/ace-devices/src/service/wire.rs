// SPDX-License-Identifier: Apache-2.0
//! The little of a `devices.*` server message that a channel's queues decide
//! about (`held-pushes.ts:4`-`:9`, `control-delivery.ts:29`-`:41`): which
//! pushes replace which, and which one is a log batch. The binding reads the
//! protocol message's fields into a [`PushKind`]; the decision stays here.

/// A push's replacement class.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushKind {
    /// `devices.state` for one device: the latest state replaces the earlier one.
    State { device_id: String },
    /// `devices.inventory`: one replaces the earlier one.
    Inventory,
    /// `devices.enabled`: one replaces the earlier one.
    Enabled,
    /// `devices.logs`: a batch that may be dropped under back pressure.
    Logs,
    /// A reply or anything else: always delivered, never replaced.
    Other,
}

impl PushKind {
    /// `replaceKey`: the key a push replaces by, or `None` for a one-off.
    pub fn replace_key(&self) -> Option<String> {
        match self {
            Self::State { device_id } => Some(format!("state:{device_id}")),
            Self::Inventory => Some(String::from("devices.inventory")),
            Self::Enabled => Some(String::from("devices.enabled")),
            Self::Logs | Self::Other => None,
        }
    }

    /// Whether this is a log batch (`control-delivery.ts:41`).
    pub fn is_logs(&self) -> bool {
        matches!(self, Self::Logs)
    }
}

/// A message and the class its kind decides about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Push<M> {
    pub kind: PushKind,
    pub message: M,
}
