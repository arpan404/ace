// SPDX-License-Identifier: Apache-2.0
//! Keeping devices and the saved `devices.enabled` in step
//! (`apps/daemon/src/devices-setting.ts`).
//!
//! Every change goes through one loop that works toward the newest choice, so a
//! slow disable, a quick on-then-off or a change made while devices load always
//! ends on the last choice. The loop itself is the shell's (it awaits the lazy
//! service and the settings store); these are the decisions it makes.

/// The newest on/off choice, and whether it still has to be saved (it came from
/// devices).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Goal {
    pub enabled: bool,
    pub save: bool,
}

/// What to do next to bring devices and the saved setting to the goal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Devices,
    Save,
    Done,
}

/// `nextDevicesStep`.
pub fn next_step(goal: Goal, devices_on: bool) -> Step {
    if devices_on != goal.enabled {
        return Step::Devices;
    }
    if goal.save { Step::Save } else { Step::Done }
}

/// `isBusy`: devices are still cleaning up after being turned off, so the loop
/// retries rather than failing.
pub fn is_busy(code: Option<&str>) -> bool {
    code == Some("busy")
}

/// The loop's newest choice and what it is applying.
#[derive(Debug, Default)]
pub struct SettingGoal {
    goal: Option<Goal>,
    applying: Option<bool>,
}

impl SettingGoal {
    pub fn new() -> Self {
        Self::default()
    }

    /// `want`: a newer choice replaces whatever the loop was working toward.
    pub fn want(&mut self, goal: Goal) {
        self.goal = Some(goal);
    }

    pub fn current(&self) -> Option<Goal> {
        self.goal
    }

    /// The loop is about to turn devices to this state.
    pub fn begin_applying(&mut self, enabled: bool) {
        self.applying = Some(enabled);
    }

    pub fn applied(&mut self) {
        self.applying = None;
    }

    /// `devices.watchEnabled`: devices echoing the state being applied is not a
    /// new choice, so nothing is saved. Returns the choice it made, if any.
    pub fn devices_changed(&mut self, enabled: bool) -> Option<Goal> {
        if self.applying == Some(enabled) {
            return None;
        }
        let goal = Goal {
            enabled,
            save: true,
        };
        self.want(goal);
        Some(goal)
    }

    /// The loop's tail after a step. A newer choice keeps it going, and devices
    /// that now match need no further work; `true` means it carries on.
    pub fn settle(&mut self, target: Goal, step: Step, devices_on: bool) -> bool {
        if self.goal != Some(target) {
            return true;
        }
        if step == Step::Devices && devices_on == target.enabled {
            return true;
        }
        self.goal = None;
        false
    }

    /// A failure that is not busy: logged, and the goal it belonged to is over.
    pub fn failed(&mut self, target: Goal) {
        if self.goal == Some(target) {
            self.goal = None;
        }
    }
}

#[cfg(test)]
mod tests;
