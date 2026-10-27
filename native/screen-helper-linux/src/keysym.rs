//! X keysyms, the key names the RemoteDesktop portal takes (`NotifyKeyboardKeysym`), and
//! wheel steps for `NotifyPointerAxisDiscrete`.
use crate::protocol::{Fault, Result};

pub fn keysym(key: &str) -> Result<u32> {
    let symbol = match key.to_ascii_lowercase().as_str() {
        "enter" | "return" => 0xff0d,
        "tab" => 0xff09,
        "escape" | "esc" => 0xff1b,
        "backspace" => 0xff08,
        "delete" => 0xffff,
        "left" | "arrowleft" => 0xff51,
        "up" | "arrowup" => 0xff52,
        "right" | "arrowright" => 0xff53,
        "down" | "arrowdown" => 0xff54,
        "home" => 0xff50,
        "end" => 0xff57,
        "space" => 32,
        "pageup" => 0xff55,
        "pagedown" => 0xff56,
        name if name
            .strip_prefix('f')
            .and_then(|n| n.parse::<u32>().ok())
            .is_some_and(|n| (1..=20).contains(&n)) =>
        {
            0xffbd + name[1..].parse::<u32>().unwrap_or(0)
        }
        _ if key.chars().count() == 1 => key.chars().next().map(u32::from).unwrap_or(0),
        _ => {
            return Err(
                Fault::new("key_unsupported", "Unsupported key").phase("rejected-before-dispatch")
            );
        }
    };
    Ok(if symbol > 255 && symbol < 0xff00 {
        0x01000000 | symbol
    } else {
        symbol
    })
}

/// Wheel clicks for a scroll in points: one notch per 40 points, at least one, at most 20.
pub fn wheel_steps(delta: f64) -> u32 {
    if delta == 0. {
        return 0;
    }
    ((delta.abs() / 40.).round() as u32).clamp(1, 20)
}
