// SPDX-License-Identifier: Apache-2.0
//! Cowork on a simulator or emulator (ADR 0143): `packages/devices/src/device-cowork.ts`
//! and the presence machine it reads (`@ace/interaction/presence`).
//!
//! The person's input from a device view goes in while an agent holds the device,
//! and extends their presence there; the agent's input waits for it to lapse, for
//! at most a minute. Only a person's explicit `controller: "human"` keeps agents
//! out (exclusive).
//!
//! Sans-IO: the clock is a parameter and the shell awaits the timer; `step` is the
//! decision a waiting action re-reads.

use indexmap::IndexMap;

use super::words;
use crate::error::DeviceError;

/// The person counts as using a surface for this long after their last input.
pub const PERSON_QUIET_MS: f64 = 3_000.0;
/// The longest an agent's action waits for the person before it gives up.
pub const PERSON_WAIT_MS: f64 = 60_000.0;
/// The catalog key of the wait's hint (`person_busy`).
pub const PERSON_BUSY_HINT: &str = "personBusyHint";

/// The surface name one device's presence lives under (`device-cowork.ts:14`).
pub fn surface_of(device_id: &str) -> String {
    format!("device:{device_id}")
}

/// What an agent's action waiting since `since` does now.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Step {
    Run,
    /// Wait this long, then look again.
    Wait(f64),
    /// The person is still there: give up with `person_busy`.
    GiveUp,
}

/// `presenceStep`: run, wait `ms` more, or give up. `person_at` is the person's
/// last input on the surface, or `None` when they have never acted there.
pub fn presence_step(
    now: f64,
    person_at: Option<f64>,
    since: f64,
    quiet_ms: f64,
    max_wait_ms: f64,
) -> Step {
    let lapses_in = person_at.unwrap_or(f64::NEG_INFINITY) + quiet_ms - now;
    if lapses_in <= 0.0 {
        return Step::Run;
    }
    let left = since + max_wait_ms - now;
    if left <= 0.0 {
        return Step::GiveUp;
    }
    Step::Wait(lapses_in.min(left))
}

/// `personActive`: the person used the surface within the quiet window.
pub fn person_active(now: f64, person_at: Option<f64>, quiet_ms: f64) -> bool {
    person_at.is_some_and(|at| now - at < quiet_ms)
}

/// `waitedNote`: the line a waited action's result carries, or `None` when it
/// barely waited (under half a second). `where_` names the surface.
pub fn waited_note(waited_ms: f64, where_: &str) -> Option<String> {
    if waited_ms < 500.0 {
        return None;
    }
    let seconds = 1.0_f64.max((waited_ms / 1_000.0).round());
    Some(format!(
        "Waited {seconds:.0} s while the person used {where_}."
    ))
}

/// `person_busy`: the person is still using the device, so nothing was done.
pub fn busy(name: &str) -> DeviceError {
    DeviceError::coded(
        crate::error::DeviceErrorCode::PersonBusy,
        format!("The person is using {name}; nothing was done"),
        words::tool_hint(PERSON_BUSY_HINT),
    )
}

/// A point on the device's screen.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// The pointer viewers draw where an agent acted.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentPointer {
    pub x: f64,
    pub y: f64,
    pub kind: String,
    /// Wall-clock time, only for the pointer's timestamp.
    pub at: f64,
}

/// `sharing`: cowork is the default; a person's own control is exclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sharing {
    Cowork,
    Exclusive,
}

impl Sharing {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cowork => "cowork",
            Self::Exclusive => "exclusive",
        }
    }
}

/// What cowork adds to a device's state for a viewer.
#[derive(Debug, Clone, PartialEq)]
pub struct View {
    pub sharing: Sharing,
    pub agent_pointer: Option<AgentPointer>,
    pub person_active: bool,
}

/// The pointer kind an activity's action draws (`device-cowork.ts:16`-`:22`).
pub fn pointer_kind(action: &str) -> &'static str {
    match action {
        "tap" | "longPress" => "click",
        "swipe" => "drag",
        "type" | "key" => "type",
        _ => "click",
    }
}

/// Cowork's own state: each surface's last input, and each device's pointer.
#[derive(Debug, Default)]
pub struct Cowork {
    last_input: IndexMap<String, f64>,
    pointers: IndexMap<String, AgentPointer>,
}

impl Cowork {
    pub fn new() -> Self {
        Self::default()
    }

    /// `personInput`: the person reached this device through a device view. A
    /// later input never moves the clock backwards. Returns whether the surface
    /// became active, so the caller can tell viewers.
    pub fn person_input(&mut self, device_id: &str, now: f64) -> bool {
        let surface = surface_of(device_id);
        let before = self.last_input.get(&surface).copied();
        if before.is_some_and(|before| before >= now) {
            return false;
        }
        let was_active = person_active(now, before, PERSON_QUIET_MS);
        self.last_input.insert(surface, now);
        !was_active
    }

    /// Whether the person is using this device now.
    pub fn active(&self, device_id: &str, now: f64) -> bool {
        person_active(
            now,
            self.last_input.get(&surface_of(device_id)).copied(),
            PERSON_QUIET_MS,
        )
    }

    /// The step a waiting action takes: run, wait this long, or give up.
    pub fn step(&self, device_id: &str, since: f64, now: f64) -> Step {
        presence_step(
            now,
            self.last_input.get(&surface_of(device_id)).copied(),
            since,
            PERSON_QUIET_MS,
            PERSON_WAIT_MS,
        )
    }

    /// `acted`: an agent acted on the device; a point there becomes the pointer
    /// viewers draw. App-level actions (opening apps, installs) show nothing.
    pub fn acted(
        &mut self,
        device_id: &str,
        action: &str,
        point: Option<Point>,
        to: Option<Point>,
        epoch_ms: f64,
    ) {
        let Some(point) = to.or(point) else {
            return;
        };
        self.pointers.insert(
            device_id.to_owned(),
            AgentPointer {
                x: point.x,
                y: point.y,
                kind: pointer_kind(action).to_owned(),
                at: epoch_ms.round().max(0.0),
            },
        );
    }

    /// `view`: a device's state with cowork's sharing, the agent's pointer and
    /// the person's presence.
    pub fn view(&self, device_id: &str, controller_is_human: bool, now: f64) -> View {
        View {
            sharing: if controller_is_human {
                Sharing::Exclusive
            } else {
                Sharing::Cowork
            },
            agent_pointer: self.pointers.get(device_id).cloned(),
            person_active: self.active(device_id, now),
        }
    }
}

#[cfg(test)]
mod tests;
