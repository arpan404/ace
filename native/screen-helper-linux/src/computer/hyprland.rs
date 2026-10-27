//! Whether Hyprland holds a session lock. Hyprland has no lock-state call, and the lock screen
//! is any client of `ext-session-lock` (hyprlock, or Omarchy 4's own shell, which runs no
//! separate process), but each monitor lists why it can't go solitary, and an active lock is
//! one reason: `LOCK` in `solitaryBlockedBy`. A monitor with no workspace yet stops at
//! `WORKSPACE` before the lock is checked, so only the other monitors say "unlocked".
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_millis(300);

/// The lock state from `j/monitors`: Some(true) locked, Some(false) unlocked, None unknown.
pub fn locked_from_monitors(json: &str) -> Option<bool> {
    let monitors: Vec<serde_json::Value> = serde_json::from_str(json).ok()?;
    let blockers = |monitor: &serde_json::Value| -> Vec<String> {
        monitor
            .get("solitaryBlockedBy")
            .and_then(|list| list.as_array())
            .map(|list| list.iter().filter_map(|b| b.as_str().map(str::to_owned)).collect())
            .unwrap_or_default()
    };
    if monitors.iter().any(|m| blockers(m).iter().any(|b| b == "LOCK")) {
        return Some(true);
    }
    if monitors.iter().any(|m| !blockers(m).iter().any(|b| b == "WORKSPACE")) {
        return Some(false);
    }
    None
}

/// Hyprland's command socket for this session, when the helper runs inside one.
fn socket() -> Option<PathBuf> {
    let instance = std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE")?;
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")?;
    Some(PathBuf::from(runtime).join("hypr").join(instance).join(".socket.sock"))
}

/// Asks the running Hyprland; None outside Hyprland or when it doesn't answer in time.
pub fn session_locked() -> Option<bool> {
    let mut stream = UnixStream::connect(socket()?).ok()?;
    stream.set_read_timeout(Some(TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(TIMEOUT)).ok()?;
    stream.write_all(b"j/monitors").ok()?;
    let mut reply = String::new();
    stream.read_to_string(&mut reply).ok()?;
    locked_from_monitors(&reply)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lock_on_any_monitor_is_locked_and_only_a_readable_monitor_says_unlocked() {
        let locked = r#"[{"name":"eDP-1","solitaryBlockedBy":["LOCK","WORKSPACE"]},{"name":"DP-1","solitaryBlockedBy":[]}]"#;
        assert_eq!(locked_from_monitors(locked), Some(true));
        let unlocked = r#"[{"name":"eDP-1","solitaryBlockedBy":["CANDIDATE"]}]"#;
        assert_eq!(locked_from_monitors(unlocked), Some(false));
        // A monitor that stopped at its missing workspace never got to the lock.
        let undetermined = r#"[{"name":"eDP-1","solitaryBlockedBy":["WORKSPACE"]}]"#;
        assert_eq!(locked_from_monitors(undetermined), None);
        assert_eq!(locked_from_monitors("not json"), None);
    }
}
