//! Typing in front: text and keys for fields accessibility can't type into, chiefly Chromium
//! and Electron apps, whose Linux accessibility offers no EditableText. It is opt-in per batch:
//! an `activate` step brings the app forward, taking the person's focus, and from then on that
//! batch's type, paste and key steps that accessibility can't do go through the desktop's
//! keyboard (`keyboard.rs`).
//!
//! Keys land wherever the desktop's focus is, so before each burst of keys the app's window
//! must still be the active one and the field still focused; otherwise typing stops and says
//! how far it got. It never starts while the person is giving input, and the person's Stop
//! ends it between bursts.
use crate::computer::act::Actor;
use crate::computer::element::{self, Element};
use crate::computer::error::{CuError, CuResult, clip};
use crate::computer::keyboard::{Keyboard, unavailable_message};
use crate::computer::keys::{self, Chord};
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// Keys between focus checks.
const BURST: usize = 16;
/// Input from the person within this long means they are at the keyboard.
const PERSON_RECENT_MS: u64 = 1500;

/// Typing in front for one helper: the keyboard, connected on first use, and this batch's state.
pub struct Front {
    data_dir: Option<PathBuf>,
    tried: bool,
    keyboard: Option<Keyboard>,
    /// Why the keyboard couldn't open at the batch's activate, for its next typing step.
    unready: Option<CuError>,
    /// This batch brought the app forward, so it may type in front.
    pub allowed: bool,
    /// Milliseconds since the person's own input, read before the step (None: unknown).
    pub person_idle_ms: Option<u64>,
    /// When this helper last sent a key, so its own keys aren't taken for the person's.
    pub last_key: Option<Instant>,
}

impl Front {
    pub fn new(data_dir: Option<PathBuf>) -> Self {
        Self {
            data_dir,
            tried: false,
            keyboard: None,
            unready: None,
            allowed: false,
            person_idle_ms: None,
            last_key: None,
        }
    }

    /// Before a batch: nothing is typed in front until the batch activates the app.
    pub fn begin(&mut self) {
        self.allowed = false;
        self.person_idle_ms = None;
        self.unready = None;
    }

    /// After a batch: the keyboard session closes; its grant stays remembered.
    pub async fn finish(&mut self) {
        if let Some(keyboard) = &mut self.keyboard {
            keyboard.close().await;
        }
    }

    /// Opens the keyboard ahead of typing; a failure is kept for the step that types.
    async fn prepare(&mut self, app: &str) {
        if let Err(error) = self.keyboard(app).await {
            self.unready = Some(error);
        }
    }

    async fn keyboard(&mut self, app: &str) -> CuResult<&Keyboard> {
        if let Some(error) = self.unready.take() {
            return Err(error);
        }
        if !self.tried {
            self.tried = true;
            self.keyboard = Keyboard::connect(self.data_dir.as_deref()).await;
        }
        let keyboard = self
            .keyboard
            .as_mut()
            .ok_or_else(|| CuError::new("not_supported", unavailable_message(app)))?;
        let was_open = keyboard.is_open();
        keyboard
            .open(app)
            .await
            .map_err(|message| CuError::new("keyboard_not_allowed", message))?;
        if !was_open {
            // Opening taps Shift to wake the new keyboard: the helper's input, not the person's.
            self.last_key = Some(Instant::now());
        }
        Ok(keyboard)
    }
}

/// Whether input the desktop saw `idle_ms` ago was the person's, not this helper's own keys
/// (sent `since_own` ago; the desktop's idle clock is coarse, so a little slack).
pub fn person_input_recent(idle_ms: Option<u64>, since_own: Option<Duration>) -> bool {
    let Some(idle) = idle_ms else { return false };
    if idle >= PERSON_RECENT_MS {
        return false;
    }
    match since_own {
        Some(own) => idle + 300 < own.as_millis() as u64,
        None => true,
    }
}

impl Actor<'_> {
    /// The hint added when a step needs typing in front but the batch hasn't opted in.
    pub fn front_hint(&self) -> String {
        format!(
            " To type in front instead, put an activate step before it in the same batch: it brings {} forward and types with the keyboard, taking the person's focus (GNOME and KDE).",
            self.session.name
        )
    }

    /// Whether the chosen window is the desktop's active one right now.
    async fn in_front(&mut self) -> bool {
        let Some(window) = self.session.window.clone() else { return false };
        self.session
            .windows(self.bus)
            .await
            .into_iter()
            .any(|w| w.obj == window.obj && w.active)
    }

    /// The step's `activate`: brings the app's window forward and lets this batch type in front.
    pub async fn activate(&mut self) -> CuResult<String> {
        let name = self.session.name.clone();
        let Some(window) = self.session.window.clone() else {
            return Err(CuError::new("no_window", format!("{name} has no open window to bring forward.")));
        };
        self.front.allowed = true;
        // The keyboard first: a desktop whose only keyboard is the portal's makes no window
        // active until it appears, and a dialog asking the person shows now, not mid-batch.
        self.front.prepare(&name).await;
        if !self.in_front().await {
            let _ = element::grab_focus(self.bus, &window.obj).await;
            crate::portal_front::activate(&self.session.id).await;
            for _ in 0..10 {
                tokio::time::sleep(Duration::from_millis(60)).await;
                if self.in_front().await {
                    break;
                }
            }
        }
        self.changed();
        if self.in_front().await {
            Ok(format!(
                "brought {name} to the front; in this batch, text and keys accessibility can't deliver go through the keyboard"
            ))
        } else {
            Ok(format!(
                "asked {name} to come to the front, but the desktop kept it behind (Wayland desktops refuse focus to programs that didn't get it from the person); typing in front needs {name} in front: ask the person to bring it forward"
            ))
        }
    }

    /// Refuses typing in front now, or says why.
    fn front_ready(&self) -> CuResult<()> {
        if !self.front.allowed {
            return Err(CuError::new("not_supported", "Typing in front needs an activate step first."));
        }
        let since_own = self.front.last_key.map(|at| at.elapsed());
        if person_input_recent(self.front.person_idle_ms, since_own) {
            return Err(CuError::new(
                "person_active",
                format!(
                    "The person is using the keyboard or mouse right now, so typing in front of them into {} would mix with their input. Wait a moment, then try again.",
                    self.session.name
                ),
            ));
        }
        Ok(())
    }

    /// The window is in front and, when given, the element has the focus.
    async fn still_focused(&mut self, element: Option<&Element>) -> bool {
        if !self.in_front().await {
            return false;
        }
        match element {
            Some(element) => element::read(self.bus, &element.obj)
                .await
                .is_ok_and(|now| now.states.focused),
            None => true,
        }
    }

    fn focus_lost(&self, label: &str, sent: usize, total: usize) -> CuError {
        let progress = if sent == 0 {
            "nothing was typed".to_owned()
        } else {
            format!("typing stopped after {sent} of {total}")
        };
        CuError::new(
            "focus_changed",
            format!(
                "{} is not in front with {label} focused, so keys would reach another window: {progress}. Activate it again (or ask the person to bring it forward), then observe and continue.",
                self.session.name
            ),
        )
    }

    /// Gives `element` the focus inside the app, waiting briefly for it to take it.
    async fn focus_field(&mut self, element: &Element, label: &str) -> CuResult<()> {
        if !self.in_front().await {
            return Err(self.focus_lost(label, 0, 0));
        }
        let _ = element::grab_focus(self.bus, &element.obj).await;
        for _ in 0..10 {
            if self.still_focused(Some(element)).await {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        Err(self.focus_lost(label, 0, 0))
    }

    /// Types `typed` into `element` with the keyboard, with the app in front.
    pub async fn type_in_front(&mut self, element: &Element, label: &str, typed: &str) -> CuResult<String> {
        self.front_ready()?;
        if let Some(c) = typed.chars().find(|c| c.is_control() && !matches!(c, '\n' | '\t')) {
            return Err(CuError::new(
                "bad_action",
                format!("The text holds a control character (U+{:04X}) that can't be typed.", c as u32),
            ));
        }
        let name = self.session.name.clone();
        self.front.keyboard(&name).await?;
        self.focus_field(element, label).await?;
        let before = element::character_count(self.bus, &element.obj).await.ok();
        let chars: Vec<char> = typed.chars().collect();
        let mut sent = 0;
        for burst in chars.chunks(BURST) {
            self.check.check()?;
            if sent > 0 && !self.still_focused(Some(element)).await {
                return Err(self.focus_lost(label, sent, chars.len()));
            }
            for c in burst {
                self.send(keys::char_keysym(*c), &[]).await?;
            }
            sent += burst.len();
        }
        self.changed();
        tokio::time::sleep(Duration::from_millis(80)).await;
        let after = element::character_count(self.bus, &element.obj).await.ok();
        let shown = clip(typed, 40).unwrap_or_default();
        Ok(match (before, after) {
            (Some(before), Some(after)) if after == before => format!(
                "typed \"{shown}\" into {label} with the keyboard, in front, but its text did not change: the field may not take typing; observe to check"
            ),
            _ => format!("typed \"{shown}\" into {label} with the keyboard, in front"),
        })
    }

    /// Presses `chord` with the keyboard, with the app in front (and `element` focused when given).
    pub async fn key_in_front(&mut self, chord: &Chord, repeat: usize, element: Option<(&Element, &str)>) -> CuResult<String> {
        self.front_ready()?;
        let name = self.session.name.clone();
        self.front.keyboard(&name).await?;
        match element {
            Some((element, label)) => self.focus_field(element, label).await?,
            None if !self.in_front().await => return Err(self.focus_lost("its window", 0, repeat)),
            None => {}
        }
        for index in 0..repeat {
            self.check.check()?;
            if index > 0 && index % BURST == 0 && !self.still_focused(element.map(|(e, _)| e)).await {
                return Err(self.focus_lost(element.map_or("its window", |(_, l)| l), index, repeat));
            }
            self.send(chord.keysym, &chord.modifiers).await?;
        }
        self.changed();
        Ok(format!("pressed {} with the keyboard, in front", chord.key))
    }

    /// One key with its modifiers held: press the modifiers, tap the key, release them in reverse.
    async fn send(&mut self, keysym: u32, modifiers: &[u32]) -> CuResult<()> {
        let name = self.session.name.clone();
        let keyboard = self.front.keyboard(&name).await?;
        let failed = |message: String| CuError::new("action_failed", message);
        for modifier in modifiers {
            keyboard.key(*modifier, true).await.map_err(failed)?;
        }
        let tapped = keyboard.press(keysym).await.map_err(failed);
        for modifier in modifiers.iter().rev() {
            keyboard.key(*modifier, false).await.ok();
        }
        self.front.last_key = Some(Instant::now());
        tapped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_input_newer_than_the_helpers_own_keys_is_the_person_at_the_keyboard() {
        // No input for a while, or the desktop doesn't say: the person isn't typing.
        assert!(!person_input_recent(Some(5000), None));
        assert!(!person_input_recent(None, None));
        // Input half a second ago, and the helper sent no keys: the person.
        assert!(person_input_recent(Some(500), None));
        // The helper's own key half a second ago explains it.
        assert!(!person_input_recent(Some(500), Some(Duration::from_millis(520))));
        // Input after the helper's last key, which was two seconds ago: the person.
        assert!(person_input_recent(Some(200), Some(Duration::from_secs(2))));
    }
}
