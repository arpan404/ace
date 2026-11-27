// SPDX-License-Identifier: Apache-2.0
//! The `sim_*` tools' descriptors (`packages/devices/src/sim-schemas.ts`): the
//! title, description, risk class and timeout an agent reads.
//!
//! The words live in M1's catalog (`native/daemon/catalog/tools.json`, read through
//! `ace-mcp`) once the devices family is registered there; until then the same
//! prose is carried here, so a registered tool and this crate cannot disagree.

use super::args::SimTool;

/// The device install budget an `sim_act` may spend (`action-budget.ts:1`).
pub const DEVICE_INSTALL_TIMEOUT_MS: u64 = 600_000;
/// The transport grace `sim_act` adds to an install.
pub const ACTION_GRACE_MS: u64 = 30_000;

/// One tool's descriptor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Descriptor {
    pub name: SimTool,
    pub title: String,
    pub description: String,
    pub risk_class: String,
    /// The tool's own budget; `sim_act` covers an install plus transport grace.
    pub timeout_ms: u64,
    /// Simulators run on this machine; nothing here reaches outside systems.
    pub open_world: bool,
    pub capability: String,
}

/// The capability every `sim_*` tool belongs to.
pub const CAPABILITY: &str = "devices";

impl SimTool {
    /// The title `simToolMetadata` gives this tool.
    fn title(self) -> &'static str {
        match self {
            Self::List => "List simulators",
            Self::Start => "Start simulator",
            Self::Stop => "Stop simulator",
            Self::Ui => "Read simulator UI",
            Self::Act => "Act on simulator",
            Self::Screenshot => "Screenshot simulator",
            Self::Logs => "Read simulator logs",
        }
    }

    /// The description an agent reads.
    fn description(self) -> &'static str {
        match self {
            Self::List => {
                "List the iOS simulators, Android emulators and Android devices on this machine."
            }
            Self::Start => {
                "Take a simulator for this thread, booting it if needed, so the person can watch. Guide: ace-computer-use."
            }
            Self::Stop => "Release the simulator when you finish.",
            Self::Ui => {
                "Read the simulator's accessibility tree, or find elements by role, name or text; refs feed sim_act."
            }
            Self::Act => {
                "Tap, type, swipe, press keys, open apps or URLs, install, record, use the clipboard or fold the simulator. stale_ref: read sim_ui again."
            }
            Self::Screenshot => {
                "Picture of the simulator screen; costlier than sim_ui. Reports its scale to input points."
            }
            Self::Logs => "Read the tail of the simulator's logs.",
        }
    }

    /// `riskClass`: what a call may change.
    fn risk_class(self) -> &'static str {
        match self {
            Self::List | Self::Ui | Self::Screenshot | Self::Logs => "read-only",
            Self::Start | Self::Stop | Self::Act => "external-effect",
        }
    }

    /// The tool's budget. Typing paces each character; installs copy whole app
    /// bundles, so `sim_act` covers the install budget and the transport grace.
    fn timeout_ms(self) -> u64 {
        match self {
            Self::Start => 250_000,
            Self::Act => DEVICE_INSTALL_TIMEOUT_MS + ACTION_GRACE_MS,
            Self::List | Self::Stop | Self::Ui | Self::Screenshot | Self::Logs => 120_000,
        }
    }

    fn descriptor(self) -> Descriptor {
        Descriptor {
            name: self,
            title: self.title().to_owned(),
            description: self.description().to_owned(),
            risk_class: self.risk_class().to_owned(),
            timeout_ms: self.timeout_ms(),
            open_world: false,
            capability: CAPABILITY.to_owned(),
        }
    }
}

/// `descriptor`: M1's catalog entry when it has one, else the prose above.
pub fn descriptor(tool: SimTool) -> Descriptor {
    let fallback = tool.descriptor();
    let Ok(catalog) = ace_mcp::catalog::catalog() else {
        return fallback;
    };
    let Some(entry) = catalog
        .tools
        .iter()
        .find(|entry| entry.name == tool.as_str())
    else {
        return fallback;
    };
    Descriptor {
        name: tool,
        title: entry.title.clone(),
        description: entry.description.clone(),
        risk_class: entry.risk_class.clone(),
        timeout_ms: entry
            .timeout_ms
            .map_or(fallback.timeout_ms, |value| value as u64),
        open_world: entry.open_world.unwrap_or(fallback.open_world),
        capability: entry
            .capability
            .clone()
            .unwrap_or_else(|| fallback.capability.clone()),
    }
}

#[cfg(test)]
mod tests;
