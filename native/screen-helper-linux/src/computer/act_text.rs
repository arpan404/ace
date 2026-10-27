//! Text and keys. Typing inserts through AT-SPI EditableText, which needs no focus and works
//! on background windows. Keys go to the focused text through AT-SPI where an equivalent
//! exists (Return, Backspace, Delete, select all, arrows); Wayland lets ace send no others.
use crate::computer::act::{Actor, Step, grab, int, set_selection, text};
use crate::computer::bus::{BusError, Obj};
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
            let (id, mut element) = self.target(step).await?;
            // A document holds its text in children (LibreOffice's paragraphs): the one with
            // the caret, else the first.
            if !element.interfaces.editable {
                if let Some(inner) = self.editable_within(&element.obj).await {
                    element = inner;
                }
            }
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

    /// An element that takes typed text inside `container`: the focused one, else the first.
    async fn editable_within(&self, container: &Obj) -> Option<Element> {
        let mut queue = std::collections::VecDeque::from([(container.clone(), 0usize)]);
        let mut first = None;
        let mut seen = 0;
        while let Some((obj, depth)) = queue.pop_front() {
            seen += 1;
            if seen > 200 {
                break;
            }
            if depth > 0 {
                if let Ok(element) = element::read(self.bus, &obj).await {
                    if element.interfaces.editable && !element.defunct {
                        if element.states.focused {
                            return Some(element);
                        }
                        first.get_or_insert(element);
                        continue;
                    }
                }
            }
            if depth < 4 {
                for child in self.bus.children(&obj).await.unwrap_or_default().into_iter().take(60) {
                    queue.push_back((child, depth + 1));
                }
            }
        }
        first
    }

    /// Why text can't go into an element that looks editable: Chromium (Chrome, Electron
    /// apps) doesn't offer AT-SPI's EditableText on Linux.
    fn not_typable(&self, element: &Element, label: &str) -> Option<CuError> {
        let chromium = crate::computer::chromium::is_chromium_process(std::path::Path::new("/proc"), self.session.pid);
        (element.states.editable && !element.interfaces.editable).then(|| {
            CuError::new(
                "not_supported",
                if chromium {
                    format!("{label} takes no typed text through accessibility: {} is built on Chromium, which doesn't offer that on Linux. Use set_value if offered, or ace's browser tools for web pages.{}", self.session.name, self.front_hint())
                } else {
                    format!("{label} takes no typed text through accessibility. Use set_value if offered.{}", self.front_hint())
                },
            )
        })
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
            if let Some(refused) = self.not_typable(&element, &label) {
                if self.front.allowed {
                    return self.type_in_front(&element, &label, &typed).await;
                }
                return Err(refused);
            }
            if element.interfaces.editable {
                return Ok(match self.insert(&element, &typed).await? {
                    Inserted::Changed => format!("typed \"{shown}\" into {label}"),
                    Inserted::Unverified => format!(
                        "typed \"{shown}\" into {label} (the app does not report its text, so this is unconfirmed)"
                    ),
                });
            }
        }
        Err(CuError::new("no_text_target", format!("Nothing that takes text is focused in {}. Pass the id of a text field (type {{text, id}}), or click one first.", self.session.name)))
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
            if let Some(refused) = self.not_typable(&element, &label) {
                if self.front.allowed {
                    return self.type_in_front(&element, &label, &pasted).await;
                }
                return Err(refused);
            }
            if element.interfaces.editable {
                return Ok(match self.insert(&element, &pasted).await? {
                    Inserted::Changed => format!("pasted {count} characters into {label}{note}"),
                    Inserted::Unverified => format!(
                        "pasted {count} characters into {label}{note} (the app does not report its text, so this is unconfirmed)"
                    ),
                });
            }
        }
        Err(CuError::new("no_text_target", format!("Nothing that takes text is focused in {}. Pass the id of a text field (paste {{text, id}}), or click one first.", self.session.name)))
    }

    pub async fn key(&mut self, step: &Step) -> CuResult<String> {
        let chord = keys::parse_chord(text(step, "key").unwrap_or_default())?;
        let repeat = int(step, "repeat").unwrap_or(1).clamp(1, 50) as usize;
        let target = if step.get("id").is_some() {
            self.text_target(step).await?
        } else {
            None
        };
        let target = match target {
            Some(target) => Some(target),
            None => self.text_target(&Step::new()).await?,
        };
        if let Some((element, label)) = target.as_ref().filter(|(e, _)| e.interfaces.text) {
            if let Some(done) = self.emulate(element, &chord, repeat).await? {
                return Ok(format!(
                    "pressed {} ({done} in {label} through accessibility)",
                    chord.key
                ));
            }
        }
        let modified = chord.modifiers.iter().any(|m| *m != keys::SHIFT);
        let function_key = (0xffbe..=0xffd5).contains(&chord.keysym);
        if (modified || function_key) && repeat == 1 {
            if let Some(done) = self.shortcut_item(&chord).await? {
                return Ok(format!("pressed {} ({done})", chord.key));
            }
        }
        if chord.keysym == 0xff09 && (chord.plain() || chord.shift_only()) {
            if let Some(done) = self.move_focus(chord.shift_only()).await? {
                return Ok(format!("pressed {} ({done} through accessibility)", chord.key));
            }
        }
        if self.front.allowed {
            let field = target.as_ref().filter(|_| step.get("id").is_some()).map(|(e, l)| (e, l.as_str()));
            return self.key_in_front(&chord, repeat, field).await;
        }
        let mut refused = self.raw_refused(&format!("The key {}", chord.key));
        refused.message.push_str(&self.front_hint());
        Err(refused)
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
            (0xff09, true, _) if editable && element.states.multi_line => {
                self.insert(element, &"\t".repeat(repeat)).await?;
                "inserted a tab".to_owned()
            }
            // Copy, cut and paste through the text's own clipboard calls.
            (0x63 | 0x43 | 0x78 | 0x58, _, true) => {
                let Some((start, end)) = selection.filter(|(start, end)| end > start) else {
                    return Err(CuError::new(
                        "nothing_selected",
                        "Nothing is selected in the text, so there is nothing to copy or cut. Select it first (select_text, or ctrl+a).",
                    ));
                };
                let cut = matches!(chord.keysym, 0x78 | 0x58);
                if cut && !editable {
                    return Ok(None);
                }
                let method = if cut { "CutText" } else { "CopyText" };
                bus.atspi::<_, ()>(obj, "EditableText", method, &(start, end))
                    .await
                    .map_err(|_| CuError::new("action_failed", "The app would not use its clipboard."))?;
                if cut {
                    self.changed();
                }
                format!("{} {} characters", if cut { "cut" } else { "copied" }, end - start)
            }
            (0x76 | 0x56, _, true) if editable => {
                if let Some((start, end)) = selection.filter(|(start, end)| end > start) {
                    delete(start, end).await;
                }
                let at = selection.map(|(start, _)| start).unwrap_or(caret);
                let pasted = bus
                    .atspi::<_, bool>(obj, "EditableText", "PasteText", &(at,))
                    .await
                    .unwrap_or(false);
                if !pasted {
                    return Ok(None);
                }
                self.changed();
                "pasted the clipboard".to_owned()
            }
            _ => return Ok(None),
        };
        Ok(Some(done))
    }

    /// A shortcut the app's menus list (Ctrl+S on File › Save): presses that item, which works
    /// in the background. GTK 3, Qt and LibreOffice give their items' accelerators.
    async fn shortcut_item(&mut self, chord: &Chord) -> CuResult<Option<String>> {
        if self.session.menu_bar.is_none() {
            self.refresh().await;
        }
        let Some(bar) = self.session.menu_bar.clone() else { return Ok(None) };
        let mut queue: std::collections::VecDeque<(Obj, Vec<String>)> = std::collections::VecDeque::from([(bar, Vec::new())]);
        let mut visited = 0;
        while let Some((container, trail)) = queue.pop_front() {
            for (obj, title) in self.menu_items(&container).await {
                visited += 1;
                if visited > 600 || trail.len() > 3 {
                    return Ok(None);
                }
                self.check.check()?;
                let mut path = trail.clone();
                path.push(title.trim().to_owned());
                let bindings = element::action_bindings(self.bus, &obj).await.unwrap_or_default();
                let found = bindings
                    .iter()
                    .position(|(_, binding)| keys::binding_chord(binding).is_some_and(|bound| keys::same_shortcut(&bound, chord)));
                if let Some(index) = found {
                    let element = element::read(self.bus, &obj).await.map_err(|_| self.busy("menu item"))?;
                    let label = path.join(" > ");
                    if !element.states.sensitive {
                        return Err(CuError::new(
                            "menu_disabled",
                            format!("{} is {label}, which is disabled right now.", chord.key),
                        ));
                    }
                    self.perform(&element, index, "menu item", &label).await?;
                    return Ok(Some(format!("chose {label}, its menu item")));
                }
                queue.push_back((obj, path));
            }
        }
        Ok(None)
    }

    /// Tab and Shift+Tab with no text to take them: the next or previous control in the outline.
    async fn move_focus(&mut self, backwards: bool) -> CuResult<Option<String>> {
        const FOCUSABLE: [&str; 13] = [
            "button", "toggle button", "check box", "radio button", "text field", "text area",
            "combo box", "link", "slider", "spin button", "tab", "menu button", "password text",
        ];
        let nodes = self.refresh().await;
        let controls: Vec<&crate::computer::outline::Node> =
            nodes.iter().filter(|n| n.actionable && FOCUSABLE.contains(&n.role.as_str())).collect();
        if controls.is_empty() {
            return Ok(None);
        }
        let focused = self.session.focused.as_ref().and_then(|f| f.id);
        let at = focused.and_then(|id| controls.iter().position(|n| n.id == id));
        let next = match (at, backwards) {
            (Some(at), false) => (at + 1) % controls.len(),
            (Some(at), true) => (at + controls.len() - 1) % controls.len(),
            (None, false) => 0,
            (None, true) => controls.len() - 1,
        };
        let id = controls[next].id;
        let element = self.session.element(self.bus, id).await?;
        if !crate::computer::act::grab(self.bus, &element.obj).await {
            return Ok(None);
        }
        self.changed();
        Ok(Some(format!("moved the focus to {}", self.label(id))))
    }
}
