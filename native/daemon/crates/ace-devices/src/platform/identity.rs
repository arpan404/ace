// SPDX-License-Identifier: Apache-2.0
//! `simulatorDevice` and `simulatorIdentity`: which listed Simulator a capture may drive, and
//! when two booted Simulators would be indistinguishable. The caller still holds the inventory.

use super::commands::native_id;
use super::{Error, Platform, Refusal};
use serde::{Deserialize, Serialize};

/// One Simulator as `xcrun simctl list devices --json` described it, with its runtime's key.
#[derive(Debug, Clone, Deserialize)]
pub struct SimulatorEntry {
    pub udid: String,
    pub name: String,
    pub state: String,
    pub runtime: String,
}

/// What the device becomes once the inventory confirms it: the Simulator's own name and
/// release, booted. The caller keeps every other field of the device it asked about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Selected {
    pub name: String,
    pub state: &'static str,
    pub runtime: String,
}

/// The device `id` names, when a booted Simulator with that UDID is listed. With `capture`,
/// two booted Simulators sharing a display name are refused: a capture must name one device.
pub fn simulator_device(
    id: &str,
    inventory: &[SimulatorEntry],
    capture: bool,
) -> Result<Selected, Error> {
    let udid = native_id(id, Platform::Ios)?;
    let Some(entry) = inventory.iter().find(|entry| entry.udid == udid) else {
        return Err(Refusal::word("simulatorNotBooted").into());
    };
    if entry.state != "Booted" {
        return Err(Refusal::word("simulatorNotBooted").into());
    }
    if capture
        && inventory.iter().any(|other| {
            other.udid != entry.udid && other.state == "Booted" && other.name == entry.name
        })
    {
        return Err(Refusal::word("simulatorNameAmbiguous").into());
    }
    Ok(Selected {
        name: entry.name.clone(),
        state: "booted",
        runtime: super::commands::simulator_runtime(&entry.runtime),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const UDID: &str = "11111111-1111-4111-8111-111111111111";

    fn entry(udid: &str, name: &str, state: &str) -> SimulatorEntry {
        SimulatorEntry {
            udid: udid.to_string(),
            name: name.to_string(),
            state: state.to_string(),
            runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0".to_string(),
        }
    }

    fn id() -> String {
        format!("ios:{UDID}")
    }

    #[test]
    fn a_listed_booted_simulator_gives_its_own_name_and_release() {
        let inventory = [entry(UDID, "iPhone 18 Pro", "Booted")];
        assert_eq!(
            simulator_device(&id(), &inventory, false).expect("booted"),
            Selected {
                name: "iPhone 18 Pro".to_string(),
                state: "booted",
                runtime: "iOS 18.0".to_string(),
            }
        );
    }

    #[test]
    fn a_simulator_that_is_missing_or_shut_down_is_refused_as_not_booted() {
        for inventory in [Vec::new(), vec![entry(UDID, "iPhone", "Shutdown")]] {
            let refused = simulator_device(&id(), &inventory, false).expect_err("not booted");
            assert!(
                matches!(refused, Error::Refused(Refusal { code, .. }) if code.as_str() == "not_booted")
            );
        }
    }

    #[test]
    fn two_booted_simulators_named_alike_stop_a_capture_but_not_a_lookup() {
        let twin = "22222222-2222-4222-8222-222222222222";
        let inventory = [
            entry(UDID, "iPhone Duo", "Booted"),
            entry(twin, "iPhone Duo", "Booted"),
        ];
        assert!(simulator_device(&id(), &inventory, false).is_ok());
        let refused = simulator_device(&id(), &inventory, true).expect_err("ambiguous");
        assert!(matches!(refused, Error::Refused(Refusal { code, .. }) if code.as_str() == "busy"));
    }

    #[test]
    fn a_shut_down_twin_leaves_the_capture_unambiguous() {
        let twin = "22222222-2222-4222-8222-222222222222";
        let inventory = [
            entry(UDID, "iPhone Duo", "Booted"),
            entry(twin, "iPhone Duo", "Shutdown"),
        ];
        assert!(simulator_device(&id(), &inventory, true).is_ok());
    }
}
