//! Synthesized keyboard and mouse input (SendInput). It goes to whatever window is in front,
//! so callers only use it after checking that the target window is in front and uncovered.
//! Every press is released, also when Windows blocks part of a batch.
use super::error::{CuError, CuResult};
use super::geometry::absolute;
use super::keys::{extended, Chord, Key, VK_CONTROL, VK_MENU, VK_SHIFT};
use super::outline::Rect;
use std::time::Duration;
use windows::Win32::UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*};

fn key_event(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: scan,
                dwFlags: flags,
                ..Default::default()
            },
        },
    }
}

fn virtual_key(vk: u16, up: bool) -> INPUT {
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    if extended(vk) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    let scan = unsafe { MapVirtualKeyW(u32::from(vk), MAPVK_VK_TO_VSC) } as u16;
    key_event(vk, scan, flags)
}

fn unicode(unit: u16, up: bool) -> INPUT {
    let mut flags = KEYEVENTF_UNICODE;
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    key_event(0, unit, flags)
}

fn mouse_event(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data as u32,
                dwFlags: flags,
                ..Default::default()
            },
        },
    }
}

fn released(input: &INPUT) -> bool {
    unsafe {
        (input.r#type == INPUT_KEYBOARD && input.Anonymous.ki.dwFlags.contains(KEYEVENTF_KEYUP))
            || (input.r#type == INPUT_MOUSE
                && input.Anonymous.mi.dwFlags.0
                    & (MOUSEEVENTF_LEFTUP | MOUSEEVENTF_RIGHTUP | MOUSEEVENTF_MIDDLEUP).0
                    != 0)
    }
}

/// Sends input. A partly blocked batch (UIPI, a desktop switch) releases what it pressed.
pub fn send(inputs: &[INPUT]) -> CuResult<()> {
    if inputs.is_empty() {
        return Ok(());
    }
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) } as usize;
    if sent == inputs.len() {
        return Ok(());
    }
    let releases: Vec<INPUT> = inputs.iter().filter(|i| released(i)).copied().collect();
    unsafe { SendInput(&releases, std::mem::size_of::<INPUT>() as i32) };
    Err(CuError::new(
        "action_failed",
        "Windows blocked the input partway (the desktop may have changed, or the app runs as administrator). Look again before retrying.",
    ))
}

/// The virtual key and extra modifiers that type a character on the current layout.
fn char_key(c: char) -> Option<(u16, Vec<u16>)> {
    let mut units = [0u16; 2];
    if c.encode_utf16(&mut units).len() != 1 {
        return None;
    }
    let scan = unsafe { VkKeyScanW(units[0]) };
    if scan == -1 {
        return None;
    }
    let vk = (scan as u16) & 0xFF;
    let state = ((scan as u16) >> 8) & 0xFF;
    let mut modifiers = Vec::new();
    if state & 1 != 0 {
        modifiers.push(VK_SHIFT);
    }
    if state & 2 != 0 {
        modifiers.push(VK_CONTROL);
    }
    if state & 4 != 0 {
        modifiers.push(VK_MENU);
    }
    Some((vk, modifiers))
}

/// Presses a chord, holding the key `hold` long.
pub fn chord(chord: &Chord, hold: Duration) -> CuResult<()> {
    let (vk, extra) = match chord.key {
        Key::Virtual(vk) => (vk, Vec::new()),
        Key::Char(c) => match char_key(c) {
            Some(found) => found,
            // Not on this layout: type it as a character when nothing else is held.
            None if chord.modifiers.is_empty() => return text(&c.to_string()),
            None => {
                return Err(CuError::new(
                    "bad_key",
                    format!(
                        "\"{c}\" is not on this keyboard layout, so {} can't be pressed.",
                        chord.name
                    ),
                ))
            }
        },
    };
    let mut modifiers = chord.modifiers.clone();
    for modifier in extra {
        if !modifiers.contains(&modifier) {
            modifiers.push(modifier);
        }
    }
    let mut down: Vec<INPUT> = modifiers.iter().map(|m| virtual_key(*m, false)).collect();
    down.push(virtual_key(vk, false));
    let mut up = vec![virtual_key(vk, true)];
    up.extend(modifiers.iter().rev().map(|m| virtual_key(*m, true)));
    if hold.is_zero() {
        down.extend(up);
        return send(&down);
    }
    send(&down)?;
    std::thread::sleep(hold);
    send(&up)
}

/// Types text as Unicode characters; newlines and tabs as Return and Tab.
pub fn text(text: &str) -> CuResult<()> {
    let mut inputs = Vec::new();
    for c in text.chars() {
        match c {
            '\r' => continue,
            '\n' => inputs.extend([virtual_key(0x0D, false), virtual_key(0x0D, true)]),
            '\t' => inputs.extend([virtual_key(0x09, false), virtual_key(0x09, true)]),
            c => {
                let mut units = [0u16; 2];
                for unit in c.encode_utf16(&mut units) {
                    inputs.extend([unicode(*unit, false), unicode(*unit, true)]);
                }
            }
        }
    }
    for batch in inputs.chunks(200) {
        send(batch)?;
    }
    Ok(())
}

pub fn desktop() -> Rect {
    unsafe {
        Rect {
            x: f64::from(GetSystemMetrics(SM_XVIRTUALSCREEN)),
            y: f64::from(GetSystemMetrics(SM_YVIRTUALSCREEN)),
            w: f64::from(GetSystemMetrics(SM_CXVIRTUALSCREEN)),
            h: f64::from(GetSystemMetrics(SM_CYVIRTUALSCREEN)),
        }
    }
}

fn move_to(point: (i32, i32)) -> CuResult<INPUT> {
    let (dx, dy) = absolute(point, desktop())
        .ok_or_else(|| CuError::new("outside_window", "That point is outside the desktop."))?;
    Ok(mouse_event(
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        dx,
        dy,
        0,
    ))
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
}

fn button_flags(button: Button) -> (MOUSE_EVENT_FLAGS, MOUSE_EVENT_FLAGS) {
    match button {
        Button::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        Button::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        Button::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    }
}

pub fn pointer_move(point: (i32, i32)) -> CuResult<()> {
    send(&[move_to(point)?])
}

/// Clicks `count` times at a screen point with modifiers held, each press held `hold` long.
pub fn click(
    point: (i32, i32),
    button: Button,
    count: u32,
    modifiers: &[u16],
    hold: Duration,
) -> CuResult<()> {
    let (down, up) = button_flags(button);
    let mut start: Vec<INPUT> = vec![move_to(point)?];
    start.extend(modifiers.iter().map(|m| virtual_key(*m, false)));
    send(&start)?;
    let finish: Vec<INPUT> = modifiers
        .iter()
        .rev()
        .map(|m| virtual_key(*m, true))
        .collect();
    let result = (|| {
        for _ in 0..count.clamp(1, 3) {
            send(&[mouse_event(down, 0, 0, 0)])?;
            if !hold.is_zero() {
                std::thread::sleep(hold);
            }
            send(&[mouse_event(up, 0, 0, 0)])?;
        }
        Ok(())
    })();
    send(&finish)?;
    result
}

/// Presses at `from`, moves in steps to `to` and releases.
pub fn drag(from: (i32, i32), to: (i32, i32), modifiers: &[u16], hold: Duration) -> CuResult<()> {
    let mut start = vec![move_to(from)?];
    start.extend(modifiers.iter().map(|m| virtual_key(*m, false)));
    start.push(mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0));
    send(&start)?;
    let result = (|| {
        std::thread::sleep(hold.max(Duration::from_millis(50)));
        for step in 1..=12 {
            let t = f64::from(step) / 12.0;
            let point = (
                (f64::from(from.0) + f64::from(to.0 - from.0) * t).round() as i32,
                (f64::from(from.1) + f64::from(to.1 - from.1) * t).round() as i32,
            );
            send(&[move_to(point)?])?;
            std::thread::sleep(Duration::from_millis(15));
        }
        Ok(())
    })();
    let mut end = vec![mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0)];
    end.extend(modifiers.iter().rev().map(|m| virtual_key(*m, true)));
    send(&end)?;
    result
}

/// Turns the wheel at a screen point: positive `notches` scroll down or right.
pub fn wheel(point: (i32, i32), horizontal: bool, notches: i32) -> CuResult<()> {
    let delta = -notches * 120;
    let (flags, delta) = if horizontal {
        (MOUSEEVENTF_HWHEEL, -delta)
    } else {
        (MOUSEEVENTF_WHEEL, delta)
    };
    send(&[move_to(point)?, mouse_event(flags, 0, 0, delta)])
}
