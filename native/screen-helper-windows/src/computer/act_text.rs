//! Typing, pasting and keys. Text goes into Win32 edit controls by message and into other
//! fields through their Value pattern, both with the window in the background; synthesized
//! keystrokes are used only when the window is in front. Shortcuts in the background press the
//! menu command bound to them, and Ctrl+A/C/X/V/Z in an edit control become its own commands.
use super::act::{hold, int, text, Actor, Step};
use super::clipboard::Clipboard;
use super::error::{CuError, CuResult};
use super::input;
use super::keys::{parse_chord, Key, VK_SHIFT};
use super::markdown::{clipboard_html, markdown_to_html};
use super::menus;
use super::timing;
use super::uia::{self, pattern, stale_or};
use windows::core::{BSTR, PCWSTR};
use windows::Win32::{
    Foundation::*,
    UI::{
        Accessibility::*,
        Controls::{EM_REPLACESEL, EM_SETSEL},
        Input::KeyboardAndMouse::{MapVirtualKeyW, MAPVK_VK_TO_VSC},
        WindowsAndMessaging::*,
    },
};

const WM_UNDO: u32 = 0x0304;

/// Where typed text goes when the window is in the background.
enum Sink {
    /// A Win32 edit control: EM_REPLACESEL inserts at its caret.
    Edit(HWND),
    /// A field with a writable Value pattern: the text is appended to its value.
    Value(IUIAutomationElement),
    /// Some other focused Win32 window: characters are posted to it.
    Posted(HWND),
}

fn send(hwnd: HWND, message: u32, wparam: usize, lparam: isize) -> bool {
    let mut result = 0usize;
    unsafe {
        SendMessageTimeoutW(
            hwnd,
            message,
            WPARAM(wparam),
            LPARAM(lparam),
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            2_000,
            Some(&mut result),
        )
        .0 != 0
    }
}

fn replace_selection(hwnd: HWND, text: &str) -> bool {
    let normalized = text.replace("\r\n", "\n").replace('\n', "\r\n");
    let wide: Vec<u16> = normalized.encode_utf16().chain(Some(0)).collect();
    send(hwnd, EM_REPLACESEL, 1, PCWSTR(wide.as_ptr()).0 as isize)
}

fn class_of(hwnd: HWND) -> String {
    let mut buffer = [0u16; 256];
    let length = unsafe { GetClassNameW(hwnd, &mut buffer) }.max(0) as usize;
    String::from_utf16_lossy(&buffer[..length])
}

/// The window with keyboard focus in the thread that owns `hwnd`, even while that thread is in
/// the background.
fn thread_focus(hwnd: HWND) -> Option<HWND> {
    let thread = unsafe { GetWindowThreadProcessId(hwnd, None) };
    let mut info = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    unsafe { GetGUIThreadInfo(thread, &mut info) }.ok()?;
    (!info.hwndFocus.is_invalid()).then_some(info.hwndFocus)
}

fn post_key(hwnd: HWND, vk: u16, repeat: u32) -> CuResult<()> {
    let scan = unsafe { MapVirtualKeyW(u32::from(vk), MAPVK_VK_TO_VSC) } as isize;
    let extended = if super::keys::extended(vk) {
        1 << 24
    } else {
        0
    };
    for _ in 0..repeat {
        let down = 1 | (scan << 16) | extended;
        let up = down | (1 << 30) | (1 << 31);
        unsafe {
            PostMessageW(hwnd, WM_KEYDOWN, WPARAM(vk as usize), LPARAM(down))
                .and_then(|_| PostMessageW(hwnd, WM_KEYUP, WPARAM(vk as usize), LPARAM(up)))
                .map_err(|e| {
                    CuError::new("action_failed", format!("The key could not be sent: {e}"))
                })?;
        }
    }
    Ok(())
}

fn post_chars(hwnd: HWND, text: &str) -> CuResult<()> {
    for c in text.chars() {
        let c = if c == '\n' { '\r' } else { c };
        let mut units = [0u16; 2];
        for unit in c.encode_utf16(&mut units) {
            unsafe { PostMessageW(hwnd, WM_CHAR, WPARAM(*unit as usize), LPARAM(1)) }.map_err(
                |e| CuError::new("action_failed", format!("The text could not be sent: {e}")),
            )?;
        }
    }
    Ok(())
}

impl Actor<'_> {
    /// The element typing goes to: the step's id, else the element the agent focused.
    fn text_target(&self, step: &Step) -> CuResult<Option<(u64, IUIAutomationElement)>> {
        if step.get("id").is_some() {
            return self.target(step).map(Some);
        }
        Ok(self
            .session
            .agent_focus
            .and_then(|id| self.session.element(id).ok().map(|element| (id, element))))
    }

    /// How text reaches the target without the window in front, if it can.
    fn sink(&self, target: Option<&IUIAutomationElement>) -> CuResult<Option<Sink>> {
        match target {
            Some(element) => {
                let fresh = self.uia.refresh(element)?;
                if let Some(hwnd) = uia::native_window(&fresh) {
                    if uia::is_edit_class(&uia::class_name(&fresh)) {
                        return Ok(Some(Sink::Edit(hwnd)));
                    }
                }
                let facts = uia::facts(&fresh);
                Ok((facts.value_writable == Some(true)).then(|| Sink::Value(element.clone())))
            }
            None => {
                let hwnd = self.session.hwnd()?;
                Ok(thread_focus(hwnd).map(|focus| {
                    if uia::is_edit_class(&class_of(focus)) {
                        Sink::Edit(focus)
                    } else {
                        Sink::Posted(focus)
                    }
                }))
            }
        }
    }

    fn append_value(element: &IUIAutomationElement, text: &str) -> CuResult<()> {
        unsafe {
            let value =
                pattern::<IUIAutomationValuePattern>(element, UIA_ValuePatternId, "typing")?;
            let current = value
                .CurrentValue()
                .map(|v| v.to_string())
                .unwrap_or_default();
            value
                .SetValue(&BSTR::from(format!("{current}{text}")))
                .map_err(|e| stale_or(e, "typing"))
        }
    }

    pub fn type_text(&mut self, step: &Step) -> CuResult<String> {
        let text = text(step, "text").unwrap_or_default().to_owned();
        let count = text.chars().count();
        let target = self.text_target(step)?;
        let into = target
            .as_ref()
            .map(|(id, _)| format!(" into {}", self.label(*id)))
            .unwrap_or_default();
        if self.in_front() {
            if let Some((_, element)) = &target {
                unsafe { element.SetFocus() }.map_err(|e| stale_or(e, "focus"))?;
            }
            input::text(&text)?;
            self.injected_now();
            return Ok(format!("typed {count} characters{into}"));
        }
        match self.sink(target.as_ref().map(|(_, e)| e))? {
            Some(Sink::Edit(hwnd)) => {
                if !replace_selection(hwnd, &text) {
                    return Err(CuError::new("app_busy", format!("{} did not take the text in time.", self.session.name)));
                }
                Ok(format!("typed {count} characters{into}"))
            }
            Some(Sink::Value(element)) => {
                Self::append_value(&element, &text)?;
                Ok(format!("typed {count} characters{into} (added to the end of its text)"))
            }
            Some(Sink::Posted(hwnd)) => {
                post_chars(hwnd, &text)?;
                Ok(format!("typed {count} characters into the focused control (sent to the window in the background; look to check)"))
            }
            None => Err(CuError::new(
                "no_text_target",
                format!("Nothing in {}'s window takes typed text in the background. Pass the id of a text field from the outline, or add activate first to type where the keyboard focus is.", self.session.name),
            )),
        }
    }

    pub fn paste(&mut self, step: &Step) -> CuResult<String> {
        let source = text(step, "text").unwrap_or_default().to_owned();
        let format = text(step, "format").unwrap_or("text");
        let count = source.chars().count();
        let html = match format {
            "markdown" => Some(markdown_to_html(&source)),
            "html" => Some(source.clone()),
            _ => None,
        };
        let target = self.text_target(step)?;
        let into = target
            .as_ref()
            .map(|(id, _)| format!(" into {}", self.label(*id)))
            .unwrap_or_default();
        let rich = if html.is_some() { " as rich text" } else { "" };
        if self.in_front() {
            if let Some((_, element)) = &target {
                unsafe { element.SetFocus() }.map_err(|e| stale_or(e, "focus"))?;
            }
            self.borrow_clipboard(&source, html.as_deref())?;
            let pasted = input::chord(&parse_chord("ctrl+v")?, std::time::Duration::ZERO);
            self.injected_now();
            self.activity.begin();
            let _ = self.activity.settle(&timing::BEFORE_LOOK, self.check);
            self.clipboard.as_mut().map(Clipboard::restore);
            pasted?;
            return Ok(format!("pasted {count} characters{into}{rich}"));
        }
        let sink = self.sink(target.as_ref().map(|(_, e)| e))?;
        match (sink, html) {
            (Some(Sink::Edit(hwnd)), None) => {
                if !replace_selection(hwnd, &source) {
                    return Err(CuError::new("app_busy", format!("{} did not take the text in time.", self.session.name)));
                }
                Ok(format!("pasted {count} characters{into}"))
            }
            (Some(Sink::Value(element)), None) => {
                Self::append_value(&element, &source)?;
                Ok(format!("pasted {count} characters{into} (added to the end of its text)"))
            }
            (Some(Sink::Edit(hwnd) | Sink::Posted(hwnd)), html) => {
                self.borrow_clipboard(&source, html.as_deref())?;
                let delivered = send(hwnd, WM_PASTE, 0, 0);
                self.clipboard.as_mut().map(Clipboard::restore);
                if !delivered {
                    return Err(CuError::new("app_busy", format!("{} did not take the paste in time.", self.session.name)));
                }
                Ok(format!("pasted {count} characters{into}{rich} (sent to the window in the background; look to check)"))
            }
            (Some(Sink::Value(element)), Some(_)) => {
                Self::append_value(&element, &source)?;
                Ok(format!("pasted {count} characters{into} as plain text: the field takes no rich text in the background"))
            }
            (None, _) => Err(CuError::new(
                "no_text_target",
                format!("Nothing in {}'s window takes a paste in the background. Pass the id of a text field, or add activate first.", self.session.name),
            )),
        }
    }

    fn borrow_clipboard(&mut self, text: &str, html: Option<&str>) -> CuResult<()> {
        if self.clipboard.is_none() {
            *self.clipboard = Some(Clipboard::new()?);
        }
        let payload = html.map(clipboard_html);
        match self.clipboard.as_mut() {
            Some(clipboard) => clipboard.borrow(text, payload.as_deref()),
            None => Err(CuError::new("internal", "The clipboard is unavailable.")),
        }
    }

    pub fn key(&mut self, step: &Step) -> CuResult<String> {
        let name = text(step, "key").unwrap_or_default();
        let chord = parse_chord(name)?;
        let repeat = int(step, "repeat").unwrap_or(1).clamp(1, 50) as u32;
        let times = if repeat > 1 {
            format!(" ×{repeat}")
        } else {
            String::new()
        };
        let target = self.text_target(step)?;
        if self.in_front() {
            if let Some((_, element)) = &target {
                unsafe { element.SetFocus() }.map_err(|e| stale_or(e, "focus"))?;
            }
            for _ in 0..repeat {
                self.check.check()?;
                input::chord(&chord, hold(step))?;
            }
            self.injected_now();
            return Ok(format!("pressed {}{times}", chord.name));
        }
        let hwnd = self.session.hwnd()?;
        let focus = match &target {
            Some((_, element)) => self
                .uia
                .refresh(element)
                .ok()
                .and_then(|fresh| uia::native_window(&fresh)),
            None => thread_focus(hwnd),
        };
        // Edit commands an edit control performs itself.
        if let (Some(letter), Some(edit)) = (
            chord.control_letter(),
            focus.filter(|f| uia::is_edit_class(&class_of(*f))),
        ) {
            let (message, wparam, lparam, what) = match letter {
                'a' => (EM_SETSEL, 0usize, -1isize, "select all"),
                'c' => (WM_COPY, 0, 0, "copy"),
                'x' => (WM_CUT, 0, 0, "cut"),
                'v' => (WM_PASTE, 0, 0, "paste"),
                'z' => (WM_UNDO, 0, 0, "undo"),
                _ => (0, 0, 0, ""),
            };
            if message != 0 {
                if !send(edit, message, wparam, lparam) {
                    return Err(CuError::new(
                        "app_busy",
                        format!("{} did not answer in time.", self.session.name),
                    ));
                }
                return Ok(format!("pressed {} ({what})", chord.name));
            }
        }
        if chord.control_letter() == Some('a') {
            if let Some((_, element)) = &target {
                unsafe {
                    if let Ok(text) =
                        element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
                    {
                        text.DocumentRange()
                            .and_then(|range| range.Select())
                            .map_err(|e| stale_or(e, "select all"))?;
                        return Ok(format!("pressed {} (select all)", chord.name));
                    }
                }
            }
        }
        if chord.shortcut() {
            if let Some((command, path)) = menus::accelerator(hwnd, &chord) {
                for _ in 0..repeat {
                    menus::post_command(hwnd, command)?;
                }
                return Ok(format!(
                    "pressed {}{times}: chose {}",
                    chord.name,
                    path.join(" › ")
                ));
            }
        }
        let shift_only = chord.modifiers.iter().all(|m| *m == VK_SHIFT);
        let recipient = focus.unwrap_or(hwnd);
        match chord.key {
            Key::Char(c) if shift_only => {
                let c = if chord.modifiers.is_empty() { c } else { c.to_uppercase().next().unwrap_or(c) };
                for _ in 0..repeat {
                    post_chars(recipient, &c.to_string())?;
                }
                Ok(format!("pressed {}{times} (sent to the window in the background)", chord.name))
            }
            Key::Virtual(vk) if chord.modifiers.is_empty() => {
                post_key(recipient, vk, repeat)?;
                Ok(format!("pressed {}{times} (sent to the window in the background)", chord.name))
            }
            _ => Err(CuError::new(
                    "window_focus_required",
                    format!(
                        "{} needs {}'s window in front: apps in the background don't receive shortcuts, and no menu command is bound to it. Add activate first (it interrupts the person), or use the menu or a control in the outline.",
                        chord.name, self.session.name
                    ),
                )),
        }
    }
}
