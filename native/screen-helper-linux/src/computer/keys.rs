//! Key chords such as "cmd+n", "shift+Tab" or "Return" as X keysyms. Pure.
//!
//! The tool schema is written for macOS, where shortcuts use ⌘. On Linux the same shortcuts
//! use Control (⌘N is Ctrl+N, ⌘C is Ctrl+C), so `cmd` maps to Control. `ctrl` is Control too;
//! `super`, `win` and `meta` name the Super key; `alt` and `option` are Alt; `fn` has no X
//! equivalent and is ignored.
use crate::computer::error::{CuError, CuResult};

pub const SHIFT: u32 = 0xffe1;
pub const CONTROL: u32 = 0xffe3;
pub const ALT: u32 = 0xffe9;
pub const SUPER: u32 = 0xffeb;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chord {
    pub keysym: u32,
    /// Modifier keysyms, in press order, without duplicates.
    pub modifiers: Vec<u32>,
    /// The key as the model named it, for the step's account.
    pub key: String,
}

impl Chord {
    pub fn plain(&self) -> bool {
        self.modifiers.is_empty()
    }
    pub fn control(&self) -> bool {
        self.modifiers == [CONTROL]
    }
    pub fn shift_only(&self) -> bool {
        self.modifiers == [SHIFT]
    }
}

fn named(key: &str) -> Option<u32> {
    let symbol = match key.to_lowercase().as_str() {
        "return" | "enter" => 0xff0d,
        "kp_enter" => 0xff8d,
        "tab" => 0xff09,
        "space" => 0x20,
        "backspace" => 0xff08,
        "delete" | "forwarddelete" | "del" => 0xffff,
        "escape" | "esc" => 0xff1b,
        "home" => 0xff50,
        "end" => 0xff57,
        "pageup" | "page_up" | "prior" => 0xff55,
        "pagedown" | "page_down" | "next" => 0xff56,
        "left" | "arrowleft" => 0xff51,
        "up" | "arrowup" => 0xff52,
        "right" | "arrowright" => 0xff53,
        "down" | "arrowdown" => 0xff54,
        "insert" => 0xff63,
        "menu" => 0xff67,
        "plus" => 0x2b,
        "minus" => 0x2d,
        "comma" => 0x2c,
        "period" => 0x2e,
        "slash" => 0x2f,
        "backslash" => 0x5c,
        other => {
            let number = other.strip_prefix('f')?.parse::<u32>().ok()?;
            if !(1..=20).contains(&number) {
                return None;
            }
            0xffbd + number
        }
    };
    Some(symbol)
}

/// The keysym that types a character: Latin-1 directly, everything else as Unicode.
pub fn char_keysym(c: char) -> u32 {
    match c {
        '\n' | '\r' => 0xff0d,
        '\t' => 0xff09,
        c if (c as u32) < 0x100 => c as u32,
        c => 0x0100_0000 | c as u32,
    }
}

pub fn parse_chord(input: &str) -> CuResult<Chord> {
    let trimmed = input.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 64 {
        return Err(CuError::new(
            "bad_key",
            "Key is empty or too long. Use names like \"cmd+n\", \"Return\", \"Escape\", \"Down\".",
        ));
    }
    // "+" alone, or a chord ending in "+" (cmd++), means the plus key.
    let mut parts: Vec<&str> = trimmed.split('+').collect();
    if trimmed == "+" {
        parts = vec!["+"];
    } else if trimmed.ends_with("++") {
        parts.truncate(parts.len() - 2);
        parts.push("+");
    }
    let key = parts.pop().unwrap_or_default();
    let mut modifiers = Vec::new();
    for modifier in parts {
        let symbol = match modifier.to_lowercase().as_str() {
            "cmd" | "command" | "ctrl" | "control" => Some(CONTROL),
            "shift" => Some(SHIFT),
            "alt" | "option" | "opt" => Some(ALT),
            "super" | "win" | "meta" => Some(SUPER),
            "fn" => None,
            _ => {
                return Err(CuError::new(
                    "bad_key",
                    format!("Unknown modifier \"{modifier}\". Use cmd (Control on Linux), ctrl, shift, alt or super."),
                ));
            }
        };
        if let Some(symbol) = symbol.filter(|s| !modifiers.contains(s)) {
            modifiers.push(symbol);
        }
    }
    if key.is_empty() {
        return Err(CuError::new(
            "bad_key",
            format!("Missing key after the modifiers in \"{input}\"."),
        ));
    }
    let mut chars = key.chars();
    let keysym = match (chars.next(), chars.next()) {
        (Some(c), None) => char_keysym(c),
        _ => named(key).ok_or_else(|| {
            CuError::new(
                "bad_key",
                format!("Unknown key \"{key}\". Use one character or a name such as Return, Tab, Escape, Backspace, Up, Down, Left, Right, Home, End, PageUp, PageDown, F1-F20."),
            )
        })?,
    };
    Ok(Chord {
        keysym,
        modifiers,
        key: trimmed.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cmd_shortcuts_become_control_shortcuts() {
        let chord = parse_chord("cmd+n").unwrap();
        assert_eq!((chord.keysym, chord.modifiers.clone()), (u32::from('n'), vec![CONTROL]));
        assert!(chord.control());
        assert_eq!(parse_chord("cmd+ctrl+a").unwrap().modifiers, vec![CONTROL]);
        assert_eq!(parse_chord("super+e").unwrap().modifiers, vec![SUPER]);
    }

    #[test]
    fn named_keys_and_the_plus_key_parse() {
        assert_eq!(parse_chord("Return").unwrap().keysym, 0xff0d);
        assert_eq!(parse_chord("shift+Tab").unwrap().modifiers, vec![SHIFT]);
        assert_eq!(parse_chord("F12").unwrap().keysym, 0xffc9);
        assert_eq!(parse_chord("cmd++").unwrap().keysym, u32::from('+'));
        assert_eq!(parse_chord("+").unwrap().keysym, u32::from('+'));
        assert_eq!(parse_chord("€").unwrap().keysym, 0x0100_20ac);
    }

    #[test]
    fn unknown_keys_and_modifiers_say_what_to_use() {
        assert!(parse_chord("hyper+x").unwrap_err().message.contains("Unknown modifier"));
        assert!(
            parse_chord("Launch")
                .unwrap_err()
                .message
                .contains("Unknown key \"Launch\"")
        );
        assert_eq!(parse_chord("cmd+").unwrap_err().code, "bad_key");
    }
}
