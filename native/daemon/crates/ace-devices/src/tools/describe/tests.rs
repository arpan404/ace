// SPDX-License-Identifier: Apache-2.0
//! The `sim_*` descriptors (`sim-schemas.ts`): the prose, risk class and budget an
//! agent reads, byte for byte.

use super::{ACTION_GRACE_MS, CAPABILITY, DEVICE_INSTALL_TIMEOUT_MS, descriptor};
use crate::tools::args::SimTool;

#[test]
fn every_tool_keeps_its_title_description_and_risk() {
    let expected = [
        (
            SimTool::List,
            "List simulators",
            "List the iOS simulators, Android emulators and Android devices on this machine.",
            "read-only",
            120_000,
        ),
        (
            SimTool::Start,
            "Start simulator",
            "Take a simulator for this thread, booting it if needed, so the person can watch. Guide: ace-computer-use.",
            "external-effect",
            250_000,
        ),
        (
            SimTool::Stop,
            "Stop simulator",
            "Release the simulator when you finish.",
            "external-effect",
            120_000,
        ),
        (
            SimTool::Ui,
            "Read simulator UI",
            "Read the simulator's accessibility tree, or find elements by role, name or text; refs feed sim_act.",
            "read-only",
            120_000,
        ),
        (
            SimTool::Act,
            "Act on simulator",
            "Tap, type, swipe, press keys, open apps or URLs, install, record, use the clipboard or fold the simulator. stale_ref: read sim_ui again.",
            "external-effect",
            DEVICE_INSTALL_TIMEOUT_MS + ACTION_GRACE_MS,
        ),
        (
            SimTool::Screenshot,
            "Screenshot simulator",
            "Picture of the simulator screen; costlier than sim_ui. Reports its scale to input points.",
            "read-only",
            120_000,
        ),
        (
            SimTool::Logs,
            "Read simulator logs",
            "Read the tail of the simulator's logs.",
            "read-only",
            120_000,
        ),
    ];
    for (tool, title, description, risk, timeout) in expected {
        let entry = descriptor(tool);
        assert_eq!(entry.name, tool);
        assert_eq!(entry.title, title, "{}", tool.as_str());
        assert_eq!(entry.description, description, "{}", tool.as_str());
        assert_eq!(entry.risk_class, risk, "{}", tool.as_str());
        assert_eq!(entry.timeout_ms, timeout, "{}", tool.as_str());
        // Simulators run on this machine; nothing here reaches outside systems.
        assert!(!entry.open_world);
        assert_eq!(entry.capability, CAPABILITY);
    }
}

#[test]
fn an_install_budget_covers_the_longest_act() {
    // The ten-minute device install budget plus the transport grace.
    assert_eq!(DEVICE_INSTALL_TIMEOUT_MS, 600_000);
    assert_eq!(ACTION_GRACE_MS, 30_000);
    assert_eq!(descriptor(SimTool::Act).timeout_ms, 630_000);
}
