//! Text and keys. Typing inserts through AT-SPI EditableText, which needs no focus and works
//! on background windows. Keys go to the focused text through AT-SPI where an equivalent
//! exists (Return, Backspace, Delete, select all, arrows); others need the window in front.
use crate::computer::act::{Actor, Step, grab, int, set_selection, text};
use crate::computer::bus::BusError;
use crate::computer::element::{self, Element};
use crate::computer::error::{CuError, CuResult, clip};
use crate::computer::keys::{self, Chord};

enum Inserted {
    Changed,
    Unverified,
}

impl Actor<'_> {
    /// The element typing goes to: the step's id (focused first), else the focused text
    /// element, else the text element the agent last worked in.
    async fn text_target(&mut self, step: &Step) -> CuResult<Option<(Element, String)>> {
        if step.get("id").is_some() {
            let (id, element) = self.target(step).await?;
            grab(self.bus, &element.obj).await;
            if element.interfaces.text {
                self.session.text_focus = Some(element.obj.clone());
            }
            return Ok(Some((element, self.label(id))));
        }
        self.refresh().await;
        let focused = self.session.focused.as_ref().and_then(|f| f.obj.clone());
        for obj in [focused, self.session.text_focus.clone()].into_iter().flatten() {
            let Ok(element) = element::read(self.bus, &obj).await else {
                continue;
            };
            if element.defunct || !element.interfaces.text {
                continue;
            }
            let label = self
                .session
                .label_of(&obj)
                .unwrap_or_else(|| "the focused element".into());
            return Ok(Some((element, label)));
        }
        Ok(None)
    }

    async fn insert(&self, element: &Element, text: &str) -> CuResult<Inserted> {
        let bus = self.bus;
        let obj = &element.obj;
        let mut caret = element::caret(bus, obj).await.unwrap_or(-1);
        if let Some((start, end)) = element::selection(bus, obj).await {
            let _ = bus
                .atspi::<_, bool>(obj, "EditableText", "DeleteText", &(start, end))
                .await;
            caret = start;
        }
        let before = element::character_count(bus, obj).await.ok();
        if caret < 0 {
            caret = before.unwrap_or(0);
        }
        let length = text.chars().count() as i32;
        let accepted = match bus
            .atspi::<_, bool>(obj, "EditableText", "InsertText", &(caret, text, length))
            .await
        {
            Ok(accepted) => accepted,
            Err(BusError::Timeout) => return Err(self.busy("typing")),
            Err(_) => false,
        };
        if !accepted {
            return Err(CuError::new(
                "action_failed",
                format!("{} refused the text.", self.session.name),
            ));
        }
        self.changed();
        let _ = bus
            .atspi::<_, bool>(obj, "Text", "SetCaretOffset", &(caret + length,))
            .await;
        let after = element::character_count(bus, obj).await.ok();
        Ok(match (before, after) {
            (Some(before), Some(after)) if after != before => Inserted::Changed,
            (Some(_), Some(_)) => {
                return Err(CuError::new(
                    "type_ignored",
                    format!(
                        "{} ignored the text. Click the field first, or use set_value.",
                        self.session.name
                    ),
                ));
            }
            _ => Inserted::Unverified,
        })
    }

    fn secure(element: &Element, verb: &str) -> CuResult<()> {
        if element.role == "password text" {
            return Err(CuError::new(
                "secure_field",
                format!("The focused field is a password field. Ask the person to {verb} it themselves."),
            ));
        }
        Ok(())
    }

    pub async fn type_text(&mut self, step: &Step) -> CuResult<String> {
        let typed = text(step, "text").unwrap_or_default().to_owned();
        if typed.is_empty() {
            return Err(CuError::new("bad_action", "type needs text."));
        }
        if typed.chars().count() > 5000 {
            return Err(CuError::new(
                "bad_action",
                "Type at most 5000 characters at a time; use set_value or paste for long text.",
            ));
        }
        let shown = clip(&typed, 40).unwrap_or_default();
        if let Some((element, label)) = self.text_target(step).await? {
            Self::secure(&element, "type")?;
            if element.interfaces.editable {
                return Ok(match self.insert(&element, &typed).await? {
                    Inserted::Changed => format!("typed \"{shown}\" into {label}"),
                    Inserted::Unverified => format!(
                        "typed \"{shown}\" into {label} (the app does not report its text, so this is unconfirmed)"
                    ),
                });
            }
        }
        let foreground = self.foreground("type").map_err(|_| {
            CuError::new("no_text_target", format!("Nothing that takes text is focused in {}. Pass the id of a text field (type {{text, id}}), or click one first.", self.session.name))
        })?;
        self.type_keys(foreground, &typed).await?;
        Ok(format!("typed \"{shown}\" with the keyboard"))
    }

    pub async fn paste(&mut self, step: &Step) -> CuResult<String> {
        let pasted = text(step, "text").unwrap_or_default().to_owned();
        if pasted.is_empty() {
            return Err(CuError::new("bad_action", "paste needs text."));
        }
        let rich = matches!(text(step, "format"), Some("markdown" | "html"));
        let note = if rich {
            " as plain text (rich paste is not available on Linux)"
        } else {
            ""
        };
        let count = pasted.chars().count();
        if let Some((element, label)) = self.text_target(step).await? {
            Self::secure(&element, "paste into")?;
            if element.interfaces.editable {
                return Ok(match self.insert(&element, &pasted).await? {
                    Inserted::Changed => format!("pasted {count} characters into {label}{note}"),
                    Inserted::Unverified => format!(
                        "pasted {count} characters into {label}{note} (the app does not report its text, so this is unconfirmed)"
                    ),
                });
            }
        }
        let foreground = self.foreground("paste").map_err(|_| {
            CuError::new("no_text_target", format!("Nothing that takes text is focused in {}. Pass the id of a text field (paste {{text, id}}), or click one first.", self.session.name))
        })?;
        if self.clipboard.is_none() {
            *self.clipboard = Some(crate::computer::clipboard::Clipboard::start()?);
        }
        // Bounded to half a second.
        let previous = crate::computer::clipboard::read();
        if let Some(clipboard) = self.clipboard.as_ref() {
            clipboard.set(pasted);
        }
        let chord = keys::parse_chord("ctrl+v")?;
        let sent = self.send_chord(foreground, &chord, 1, 0).await;
        crate::computer::events::pause(300, self.check).await.ok();
        if let (Some(clipboard), Some(previous)) = (self.clipboard.as_ref(), previous) {
            clipboard.set(previous);
        }
        sent?;
        Ok(format!("pasted {count} characters with the clipboard{note}"))
    }

    pub async fn key(&mut self, step: &Step) -> CuResult<String> {
        let chord = keys::parse_chord(text(step, "key").unwrap_or_default())?;
        let repeat = int(step, "repeat").unwrap_or(1).clamp(1, 50) as usize;
        let hold = int(step, "hold_ms").unwrap_or(0).clamp(0, 5000) as u64;
        let target = if step.get("id").is_some() {
            self.text_target(step).await?
        } else {
            None
        };
        if let Ok(foreground) = self.foreground("key") {
            self.send_chord(foreground, &chord, repeat, hold).await?;
            return Ok(format!(
                "pressed {}{}",
                chord.key,
                if repeat > 1 {
                    format!(" ×{repeat}")
                } else {
                    String::new()
                }
            ));
        }
        let target = match target {
            Some(target) => Some(target),
            None => self.text_target(&Step::new()).await?,
        };
        if let Some((element, label)) = target.filter(|(e, _)| e.interfaces.text) {
            if let Some(done) = self.emulate(&element, &chord, repeat).await? {
                return Ok(format!(
                    "pressed {} ({done} in {label} through accessibility)",
                    chord.key
                ));
            }
        }
        Err(self
            .foreground("key")
            .err()
            .unwrap_or_else(|| CuError::new("not_supported", "This key can't be sent.")))
    }

    /// The text-editing keys AT-SPI can do without the window in front.
    async fn emulate(&self, element: &Element, chord: &Chord, repeat: usize) -> CuResult<Option<String>> {
        let bus = self.bus;
        let obj = &element.obj;
        let editable = element.interfaces.editable && element.role != "password text";
        let count = element::character_count(bus, obj).await.unwrap_or(0);
        let caret = element::caret(bus, obj).await.unwrap_or(count);
        let selection = element::selection(bus, obj).await;
        let delete = |start: i32, end: i32| async move {
            bus.atspi::<_, bool>(obj, "EditableText", "DeleteText", &(start, end))
                .await
                .unwrap_or(false)
        };
        let done = match (chord.keysym, chord.plain(), chord.control()) {
            (0xff0d | 0xff8d, true, _) if editable && element.states.multi_line => {
                let newlines = "\n".repeat(repeat);
                self.insert(element, &newlines).await?;
                "inserted a line break".to_owned()
            }
            (0xff0d | 0xff8d, true, _) => {
                let actions = element::action_names(bus, obj).await.unwrap_or_default();
                let Some(index) = actions.iter().position(|a| a == "activate") else {
                    return Ok(None);
                };
                self.perform(element, index, "activate", "the field").await?;
                "activated the field".to_owned()
            }
            (0xff08 | 0xffff, true, _) if editable => {
                let (start, end) = match selection {
                    Some(range) => range,
                    None if chord.keysym == 0xff08 => ((caret - repeat as i32).max(0), caret),
                    None => (caret, (caret + repeat as i32).min(count)),
                };
                if start == end || !delete(start, end).await {
                    return Ok(None);
                }
                self.changed();
                format!("deleted {} characters", end - start)
            }
            (0x61 | 0x41, _, true) => {
                set_selection(bus, obj, 0, count)
                    .await
                    .map_err(|_| CuError::new("action_failed", "The app would not select its text."))?;
                self.changed();
                "selected all text".to_owned()
            }
            (0xff51 | 0xff53 | 0xff50 | 0xff57, true, _) => {
                let to = match chord.keysym {
                    0xff51 => (caret - repeat as i32).max(0),
                    0xff53 => (caret + repeat as i32).min(count),
                    0xff50 => 0,
                    _ => count,
                };
                set_selection(bus, obj, to, to)
                    .await
                    .map_err(|_| CuError::new("action_failed", "The app would not move its caret."))?;
                self.changed();
                "moved the caret".to_owned()
            }
            _ => return Ok(None),
        };
        Ok(Some(done))
    }
}
