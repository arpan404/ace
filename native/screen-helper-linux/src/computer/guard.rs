//! When the person wins over the agent. Pure: the facts are read elsewhere (`presence.rs`),
//! so these rules are tested directly. They follow the macOS engine's (`ComputerGuards.swift`):
//! the person's Stop ends the agent's work, an unavailable session stops it, and an action
//! is refused while the person is using that same control or window right now.
use crate::computer::error::{CuError, CuResult};

/// The person's desktop session, as the system reports it. An unknown fact never reads as
/// locked or unavailable: only a positive report does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionStatus {
    Active,
    Locked,
    Unavailable,
}

impl SessionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionStatus::Active => "active",
            SessionStatus::Locked => "locked",
            SessionStatus::Unavailable => "unavailable",
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SessionFacts {
    /// logind's `Active` for the user's graphical session: false while another session is in
    /// front of the seat (a switched user) or the session is gone.
    pub logind_active: Option<bool>,
    /// logind's `LockedHint` for that session.
    pub logind_locked: Option<bool>,
    /// The desktop's screensaver says the lock screen is up (`org.gnome.ScreenSaver` or
    /// `org.freedesktop.ScreenSaver` `GetActive`).
    pub screensaver_active: Option<bool>,
    /// A session-lock client (hyprlock, swaylock) runs as this user: on Hyprland the lock
    /// screen is a client of the compositor, not a D-Bus service.
    pub locker_running: bool,
    /// The compositor itself holds a session lock (Hyprland's monitors say so), whichever
    /// client draws it: Omarchy 4 locks from its own shell, with no lock program to find.
    pub compositor_locked: Option<bool>,
}

pub fn session_status(facts: &SessionFacts) -> SessionStatus {
    if facts.logind_active == Some(false) {
        return SessionStatus::Unavailable;
    }
    if facts.logind_locked == Some(true)
        || facts.screensaver_active == Some(true)
        || facts.locker_running
        || facts.compositor_locked == Some(true)
    {
        return SessionStatus::Locked;
    }
    SessionStatus::Active
}

/// Input from the person within this long counts as them using the computer right now.
pub const RECENT_INPUT_MS: u64 = 1500;

/// Where an action lands relative to the person, for `conflicts_with_person`.
#[derive(Clone, Copy, Debug, Default)]
pub struct TargetFacts {
    /// A look, not an action.
    pub observing: bool,
    /// The step names its element by id.
    pub explicit_target: bool,
    /// The agent's chosen window is the app's active window, the one the person is in.
    pub same_window: bool,
    /// The person's focused element in that window is known.
    pub focus_known: bool,
    /// The step's element is, or contains, the person's focused element.
    pub contains_focus: bool,
}

/// An action conflicts with the person when it would land where they are working: any step in
/// their window that names no element (keys, typing, menus go to the focused control), or an
/// element step on their focused control. Another window, or another element of theirs when
/// their focus is known, is independent. Unknown focus is conservative.
pub fn conflicts_with_person(target: &TargetFacts) -> bool {
    if target.observing || !target.same_window {
        return false;
    }
    if !target.explicit_target {
        return true;
    }
    !target.focus_known || target.contains_focus
}

#[derive(Clone, Copy, Debug)]
pub struct GuardFacts {
    /// The person pressed Stop.
    pub stop_requested: bool,
    pub status: SessionStatus,
    /// One of the app's windows is the active window.
    pub app_active: bool,
    /// Milliseconds since the person's last keyboard or pointer input; None where the
    /// desktop doesn't say.
    pub ms_since_input: Option<u64>,
}

impl GuardFacts {
    /// Whether the person may be using the app right now, so the conflict must be checked.
    pub fn person_may_be_using(&self) -> bool {
        self.status == SessionStatus::Active
            && self.app_active
            && self.ms_since_input.is_some_and(|ms| ms < RECENT_INPUT_MS)
    }
}

pub fn stopped_by_person() -> CuError {
    CuError::new(
        "stopped_by_person",
        "The person pressed Stop to end computer use. Stop acting and ask them how they want to continue.",
    )
}

pub fn session_unavailable() -> CuError {
    CuError::new(
        "session_unavailable",
        "This computer's desktop session is not in front (another user's session is, or it ended). Stop computer actions until the person's session returns, then observe again. Other tools can continue.",
    )
}

/// Whether an action may run now. `conflict` is only asked when the person may be using the
/// app, since it reads the app's focus. The person always wins.
pub fn guard(facts: &GuardFacts, app: &str, conflict: impl FnOnce() -> bool) -> CuResult<()> {
    if facts.stop_requested {
        return Err(stopped_by_person());
    }
    if facts.status == SessionStatus::Unavailable {
        return Err(session_unavailable());
    }
    if facts.person_may_be_using() && conflict() {
        return Err(CuError::new(
            "person_active",
            format!(
                "The person is using this control in {app} right now. Select another element or window, or wait before trying again."
            ),
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "guard_tests.rs"]
mod tests;
