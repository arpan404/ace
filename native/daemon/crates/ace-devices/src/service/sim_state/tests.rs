// SPDX-License-Identifier: Apache-2.0
//! `SimAgentState` (`sim-state.ts`): the how-to rides on an agent's first start of
//! a device, and the oldest starts are forgotten past the cap.
//!
//! `sim-state.ts` has no test file of its own (behaviour.md §5 lists none), so
//! these cases are the module's only guard.

use super::{MAX_GUIDED, SimAgentState};

#[test]
fn the_first_start_of_a_device_gets_the_how_to_once() {
    let mut state = SimAgentState::new();
    assert!(state.first_start("agent-1", "ios:AAAA"));
    assert!(
        !state.first_start("agent-1", "ios:AAAA"),
        "only the first time"
    );
    // Another device, and another agent, each get their own first start.
    assert!(state.first_start("agent-1", "android:emulator-5554"));
    assert!(state.first_start("agent-2", "ios:AAAA"));
}

#[test]
fn the_oldest_first_start_is_forgotten_past_the_cap() {
    let mut state = SimAgentState::new();
    for index in 0..=MAX_GUIDED {
        assert!(state.first_start(&format!("agent-{index}"), "ios:AAAA"));
    }
    assert_eq!(state.guided(), MAX_GUIDED);
    // The oldest is forgotten, so it gets the how-to again; the newest does not.
    assert!(state.first_start("agent-0", "ios:AAAA"));
    assert!(!state.first_start(&format!("agent-{MAX_GUIDED}"), "ios:AAAA"));
}
