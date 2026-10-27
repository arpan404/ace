//! Key chords such as "ctrl+s", "shift+Tab" or "Return" as Windows virtual keys. Pure.
//!
//! The tool schema is written for macOS, where shortcuts use ⌘. Windows apps use Control for
//! the same shortcuts (⌘S is Ctrl+S), so `cmd` maps to Control. `ctrl` is Control too; `win`,
//! `super` and `meta` name the Windows key; `alt` and `option` are Alt; `fn` has no Windows
//! equivalent and is ignored.
use super::error::{CuError, CuResult};

pub const VK_SHIFT: u16 = 0x10;
pub const VK_CONTROL: u16 = 0x11;
pub const VK_MENU: u16 = 0x12;
pub const VK_LWIN: u16 = 0x5B;
pub const VK_RETURN: u16 = 0x0D;
pub const VK_ESCAPE: u16 = 0x1B;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    /// A virtual key, such as VK_RETURN.
    Virtual(u16),
    /// A character; the current keyboard layout decides its virtual key.
    Char(char),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chord {
    pub key: Key,
    /// Modifier virtual keys, in press order, without duplicates.
    pub modifiers: Vec<u16>,
    /// The key as the model named it, for the step's account.
    pub name: String,
}

impl Chord {
    pub fn plain(&self) -> bool {
        self.modifiers.is_empty()
    }

    pub fn shortcut(&self) -> bool {
        self.modifiers
            .iter()
            .any(|m| matches!(*m, VK_CONTROL | VK_MENU | VK_LWIN))
    }

    /// Ctrl plus this letter and nothing else, for the edit commands handled without input.
    pub fn control_letter(&self) -> Option<char> {
        match self.key {
            Key::Char(c) if self.modifiers == [VK_CONTROL] => Some(c.to_ascii_lowercase()),
            _ => None,
        }
    }
}

/// Virtual keys that need KEYEVENTF_EXTENDEDKEY: the navigation cluster, not the numpad.
pub fn extended(vk: u16) -> bool {
    matches!(
        vk,
        0x21..=0x28 | 0x2D | 0x2E | 0x5B | 0x5C | 0x5D | 0x6F | 0x90
    )
}

fn named(key: &str) -> Option<u16> {
    let vk = match key.to_lowercase().as_str() {
        "return" | "enter" | "kp_enter" => VK_RETURN,
        "tab" => 0x09,
        "space" => 0x20,
        "backspace" => 0x08,
        "delete" | "forwarddelete" | "del" => 0x2E,
        "escape" | "esc" => VK_ESCAPE,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" | "page_up" | "pgup" | "prior" => 0x21,
        "pagedown" | "page_down" | "pgdn" | "next" => 0x22,
        "left" | "arrowleft" => 0x25,
        "up" | "arrowup" => 0x26,
        "right" | "arrowright" => 0x27,
        "down" | "arrowdown" => 0x28,
        "insert" | "ins" => 0x2D,
        "menu" | "apps" | "contextmenu" => 0x5D,
        "capslock" => 0x14,
        "printscreen" => 0x2C,
        "pause" => 0x13,
        "plus" => return None,
        other => {
            let number = other.strip_prefix('f')?.parse::<u16>().ok()?;
            if !(1..=24).contains(&number) {
                return None;
            }
            0x70 + number - 1
        }
    };
    Some(vk)
}

pub fn parse_chord(input: &str) -> CuResult<Chord> {
    let trimmed = input.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 64 {
        return Err(CuError::new(
            "bad_key",
            "Key is empty or too long. Use names like \"ctrl+n\", \"Return\", \"Escape\", \"Down\".",
        ));
    }
    // "+" alone, or a chord ending in "+" (ctrl++), means the plus key.
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
        let vk = match modifier.trim().to_lowercase().as_str() {
            "cmd" | "command" | "ctrl" | "control" => Some(VK_CONTROL),
            "shift" => Some(VK_SHIFT),
            "alt" | "option" | "opt" => Some(VK_MENU),
            "win" | "super" | "meta" | "windows" => Some(VK_LWIN),
            "fn" => None,
            _ => {
                return Err(CuError::new(
                    "bad_key",
                    format!("Unknown modifier \"{modifier}\". Use ctrl (cmd also means ctrl on Windows), shift, alt or win."),
                ));
            }
        };
        if let Some(vk) = vk.filter(|vk| !modifiers.contains(vk)) {
            modifiers.push(vk);
        }
    }
    if key.is_empty() {
        return Err(CuError::new(
            "bad_key",
            format!("Missing key after the modifiers in \"{input}\"."),
        ));
    }
    let mut chars = key.chars();
    let key = match (chars.next(), chars.next()) {
        (Some(c), None) => Key::Char(c),
        _ if key.eq_ignore_ascii_case("plus") => Key::Char('+'),
        _ => Key::Virtual(named(key).ok_or_else(|| {
            CuError::new(
                "bad_key",
                format!("Unknown key \"{key}\". Use one character or a name such as Return, Tab, Escape, Backspace, Delete, Up, Down, Left, Right, Home, End, PageUp, PageDown, F1-F24."),
            )
        })?),
    };
    Ok(Chord {
        key,
        modifiers,
        name: trimmed.to_owned(),
    })
}

/// Parses a menu item's accelerator text ("Ctrl+S", "Ctrl+Shift+N", "Del", "F5"), as Win32
/// menus show it after a tab. None for text that is not a key chord.
pub fn accelerator(text: &str) -> Option<Chord> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    parse_chord(text).ok()
}

/// Whether two chords press the same keys: letters match regardless of case, modifiers in any
/// order.
pub fn same_keys(a: &Chord, b: &Chord) -> bool {
    let key = |chord: &Chord| match chord.key {
        Key::Char(c) => Key::Char(c.to_ascii_lowercase()),
        other => other,
    };
    let mods = |chord: &Chord| {
        let mut mods = chord.modifiers.clone();
        mods.sort_unstable();
        mods
    };
    key(a) == key(b) && mods(a) == mods(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cmd_shortcuts_become_control_shortcuts() {
        let chord = parse_chord("cmd+n").unwrap();
        assert_eq!(chord.key, Key::Char('n'));
        assert_eq!(chord.modifiers, vec![VK_CONTROL]);
        assert_eq!(chord.control_letter(), Some('n'));
        assert!(chord.shortcut());
        assert_eq!(
            parse_chord("cmd+ctrl+a").unwrap().modifiers,
            vec![VK_CONTROL]
        );
        assert_eq!(parse_chord("win+e").unwrap().modifiers, vec![VK_LWIN]);
        assert!(!parse_chord("shift+Tab").unwrap().shortcut());
    }

    #[test]
    fn named_keys_and_the_plus_key_parse() {
        assert_eq!(parse_chord("Return").unwrap().key, Key::Virtual(VK_RETURN));
        assert_eq!(parse_chord("F12").unwrap().key, Key::Virtual(0x7B));
        assert_eq!(parse_chord("F24").unwrap().key, Key::Virtual(0x87));
        assert_eq!(parse_chord("ctrl++").unwrap().key, Key::Char('+'));
        assert_eq!(parse_chord("+").unwrap().key, Key::Char('+'));
        assert_eq!(parse_chord("€").unwrap().key, Key::Char('€'));
        assert!(extended(0x25) && !extended(VK_RETURN));
    }

    #[test]
    fn unknown_keys_and_modifiers_say_what_to_use() {
        assert!(parse_chord("hyper+x")
            .unwrap_err()
            .message
            .contains("Unknown modifier"));
        assert!(parse_chord("Launch")
            .unwrap_err()
            .message
            .contains("Unknown key \"Launch\""));
        assert_eq!(parse_chord("ctrl+").unwrap_err().code, "bad_key");
    }

    #[test]
    fn menu_accelerators_match_the_chord_that_presses_them() {
        let save = accelerator("Ctrl+S").unwrap();
        assert!(same_keys(&save, &parse_chord("cmd+s").unwrap()));
        let new = accelerator("Ctrl+Shift+N").unwrap();
        assert!(same_keys(&new, &parse_chord("shift+ctrl+n").unwrap()));
        assert!(!same_keys(&new, &parse_chord("ctrl+n").unwrap()));
        assert!(same_keys(
            &accelerator("Del").unwrap(),
            &parse_chord("Delete").unwrap()
        ));
        assert!(accelerator("").is_none());
    }
}
