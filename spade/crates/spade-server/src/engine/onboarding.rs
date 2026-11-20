//! First run (the main Spade's chat): whether the person has been through the short "About you"
//! interview and the starter bots, done or skipped, so no client asks again. Kept in Spade's
//! settings; the interview's answers are ordinary shared notes the person can edit later.

use spade_store::StoreError;

use super::Engine;

/// The steps of first run, in order.
pub const STEPS: [&str; 2] = ["about_you", "starters"];

/// What became of one step.
pub fn valid(state: &str) -> bool {
    matches!(state, "done" | "skipped")
}

fn key(step: &str) -> String {
    format!("onboarding:{step}")
}

impl Engine {
    /// Each step and what became of it (`done`, `skipped`, or `None` while still to do).
    pub fn onboarding(&self) -> Result<Vec<(&'static str, Option<String>)>, StoreError> {
        STEPS
            .iter()
            .map(|step| Ok((*step, self.store.setting(&key(step))?)))
            .collect()
    }

    /// Records what became of `step`; `None` asks it again.
    pub fn set_onboarding(&self, step: &str, state: Option<&str>) -> Result<(), StoreError> {
        self.store.set_setting(&key(step), state)
    }
}
