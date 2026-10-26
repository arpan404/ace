//! Runs model steps against one app. Each returns a one-line account of what it did, so the
//! model knows which path was taken. Steps go through UI Automation first, which works on
//! windows in the background; synthesized input (`input`) needs the window in front and is
//! used only when it is.
use super::apps;
use super::cancel::Checkpoint;
use super::clipboard::Clipboard;
use super::conditions::{self, Condition};
use super::desktop::{self, PersonWatch};
use super::error::{clip, CuError, CuResult};
use super::geometry::Shot;
use super::input::{self, Button};
use super::keys::{VK_CONTROL, VK_LWIN, VK_MENU, VK_SHIFT};
use super::outline::{self, Node, TOGGLE_ON};
use super::session::AppSession;
use super::settle::Activity;
use super::timing;
use super::uia::{self, pattern, stale_or, Uia};
use serde_json::{Map, Value};
use std::time::{Duration, Instant};
use windows::core::Interface;
use windows::Win32::{
    Foundation::*,
    UI::{Accessibility::*, WindowsAndMessaging::*},
};

pub type Step = Map<String, Value>;

pub struct Actor<'a> {
    pub uia: &'a Uia,
    pub session: &'a mut AppSession,
    pub activity: &'a mut Activity,
    pub check: &'a Checkpoint,
    pub person: &'a PersonWatch,
    pub clipboard: &'a mut Option<Clipboard>,
    /// The app's processes, for telling its own popups from other apps' windows.
    pub pids: Vec<u32>,
}

pub fn int(step: &Step, key: &str) -> Option<i64> {
    step.get(key)
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
}

pub fn number(step: &Step, key: &str) -> Option<f64> {
    step.get(key).and_then(Value::as_f64)
}

pub fn text<'s>(step: &'s Step, key: &str) -> Option<&'s str> {
    step.get(key).and_then(Value::as_str)
}

pub fn modifiers(step: &Step) -> CuResult<Vec<u16>> {
    let mut keys = Vec::new();
    for name in step
        .get("modifiers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let vk = match name {
            "cmd" | "ctrl" => VK_CONTROL,
            "shift" => VK_SHIFT,
            "alt" => VK_MENU,
            "fn" => continue,
            "win" => VK_LWIN,
            other => {
                return Err(CuError::new(
                    "bad_action",
                    format!("Unknown modifier \"{other}\"; use cmd or ctrl (both are Ctrl on Windows), shift or alt."),
                ))
            }
        };
        if !keys.contains(&vk) {
            keys.push(vk);
        }
    }
    Ok(keys)
}

pub fn hold(step: &Step) -> Duration {
    Duration::from_millis(int(step, "hold_ms").unwrap_or(0).clamp(0, 5_000) as u64)
}

impl Actor<'_> {
    pub fn run(&mut self, step: &Step) -> CuResult<String> {
        let kind = text(step, "type")
            .ok_or_else(|| CuError::new("bad_action", "Each action needs a type."))?
            .to_owned();
        if self.person.escaped() {
            return Err(CuError::new(
                "stopped_by_person",
                "The person pressed Esc to stop the agent. Ask them before acting in this app again.",
            ));
        }
        if let Ok(hwnd) = self.session.hwnd() {
            if timing::person_active(apps::is_foreground(hwnd), desktop::since_person_input()) {
                return Err(CuError::new(
                    "person_active",
                    format!("The person is using {} right now. Wait a moment and try again, or work in another app.", self.session.name),
                ));
            }
        }
        if let Some(condition) = conditions::condition(step.get("when"))? {
            let nodes = self.refresh();
            if !conditions::holds(&condition, &nodes) {
                return Ok(format!("skipped {kind}: condition not met"));
            }
        }
        match kind.as_str() {
            "click" => self.click(step),
            "move" => self.move_pointer(step),
            "drag" => self.drag(step),
            "type" => self.type_text(step),
            "paste" => self.paste(step),
            "key" => self.key(step),
            "set_value" => self.set_value(step),
            "select_text" => self.select_text(step),
            "focus" => self.focus(step),
            "action" => self.named_action(step),
            "scroll" => self.scroll(step),
            "scroll_to" => self.scroll_to(step),
            "menu" => self.menu(step),
            "window" => self.window_op(step),
            "wait" => {
                let ms = int(step, "ms").unwrap_or(500).clamp(0, 10_000) as u64;
                self.activity.pause(Duration::from_millis(ms), self.check)?;
                Ok(format!("waited {ms} ms"))
            }
            "wait_for" => self.wait_for(step),
            "activate" => self.activate(),
            other => Err(CuError::new(
                "bad_action",
                format!("Unknown action type \"{other}\"."),
            )),
        }
    }

    /// A fresh walk of the chosen window, for conditions and waits.
    pub fn refresh(&mut self) -> Vec<Node> {
        self.session.walk(self.uia, Duration::from_secs(2));
        self.session.nodes.clone()
    }

    pub fn id(step: &Step) -> CuResult<u64> {
        step.get("id")
            .and_then(Value::as_u64)
            .ok_or_else(|| CuError::new("bad_action", "This action needs an element id."))
    }

    pub fn target(&self, step: &Step) -> CuResult<(u64, IUIAutomationElement)> {
        let id = Self::id(step)?;
        Ok((id, self.session.element(id)?))
    }

    pub fn label(&self, id: u64) -> String {
        self.session.label(id)
    }

    /// Whether synthesized input would reach the window: it is in front on the normal desktop.
    pub fn in_front(&self) -> bool {
        self.session
            .hwnd()
            .is_ok_and(|hwnd| apps::is_foreground(hwnd) && desktop::input_on_default_desktop())
    }

    /// The window, when synthesized input for `what` may go to it; a model-facing refusal
    /// otherwise.
    pub fn front(&self, what: &str) -> CuResult<HWND> {
        let hwnd = self.session.hwnd()?;
        if !desktop::input_on_default_desktop() {
            return Err(desktop::locked_error());
        }
        if !apps::is_foreground(hwnd) {
            return Err(CuError::new(
                "window_focus_required",
                format!(
                    "{what} needs {}'s window in front: Windows sends pointer and keyboard input only to the window in front. Add activate before this step (it interrupts the person), or use an element id from the outline.",
                    self.session.name
                ),
            ));
        }
        Ok(hwnd)
    }

    /// Refuses a screen point another app's window covers.
    pub fn uncovered(&self, point: (i32, i32)) -> CuResult<()> {
        let hit = unsafe {
            GetAncestor(
                WindowFromPoint(POINT {
                    x: point.0,
                    y: point.1,
                }),
                GA_ROOT,
            )
        };
        if self.pids.contains(&apps::pid_of(hit)) {
            return Ok(());
        }
        Err(CuError::new(
            "not_on_screen",
            format!("Another window covers that point of {}'s window, so a click would land there. Use an element id, or move the window first.", self.session.name),
        ))
    }

    pub fn shot(&self) -> CuResult<Shot> {
        let hwnd = self.session.hwnd()?;
        match self.session.shot {
            Some((shot_window, shot)) if shot_window == hwnd => Ok(shot),
            _ => Err(CuError::new(
                "no_screenshot",
                "x,y are pixels in a screenshot of this window; take one first (screen_state with screenshot:true), or use an element id.",
            )),
        }
    }

    /// A screenshot pixel as a screen point, with the window pixel it maps to.
    pub fn screen_point(&self, x: f64, y: f64) -> CuResult<((i32, i32), (f64, f64))> {
        let shot = self.shot()?;
        let window = shot.window_point(x, y).ok_or_else(|| {
            CuError::new(
                "outside_window",
                format!(
                    "({x}, {y}) is outside the {}×{} screenshot.",
                    shot.width, shot.height
                ),
            )
        })?;
        Ok((shot.screen_point(window), window))
    }

    /// The centre of an element on the screen.
    pub fn center(&self, element: &IUIAutomationElement, label: &str) -> CuResult<(i32, i32)> {
        let rect = unsafe { element.CurrentBoundingRectangle() }
            .map_err(|e| stale_or(e, "position read"))?;
        if rect.right <= rect.left || rect.bottom <= rect.top {
            return Err(CuError::new(
                "not_on_screen",
                format!("{label} has no position on screen (it may be scrolled out of view). Try scroll_to first."),
            ));
        }
        Ok(((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2))
    }

    /// Presses an element by UI Automation, the way its plain click would.
    fn press(&mut self, id: u64, element: &IUIAutomationElement) -> CuResult<String> {
        let label = self.label(id);
        let fresh = self.uia.refresh(element)?;
        let facts = uia::facts(&fresh);
        if !facts.enabled {
            return Err(CuError::new(
                "action_failed",
                format!("{label} is disabled."),
            ));
        }
        // Rows and tabs are chosen by selection: their legacy default action is a synthesized
        // click, which would bring the window forward.
        let item = matches!(
            facts.control_type,
            outline::control::LIST_ITEM
                | outline::control::TREE_ITEM
                | outline::control::DATA_ITEM
                | outline::control::TAB_ITEM
        );
        unsafe {
            if item && facts.selected.is_some() {
                pattern::<IUIAutomationSelectionItemPattern>(
                    element,
                    UIA_SelectionItemPatternId,
                    "selection",
                )?
                .Select()
                .map_err(|e| stale_or(e, "selection"))?;
                return Ok(format!("selected {label}"));
            }
            if facts.invoke {
                pattern::<IUIAutomationInvokePattern>(element, UIA_InvokePatternId, "press")?
                    .Invoke()
                    .map_err(|e| stale_or(e, "press"))?;
                return Ok(format!("pressed {label}"));
            }
            if facts.toggle.is_some() {
                let toggle =
                    pattern::<IUIAutomationTogglePattern>(element, UIA_TogglePatternId, "toggle")?;
                toggle.Toggle().map_err(|e| stale_or(e, "toggle"))?;
                let on = toggle.CurrentToggleState().is_ok_and(|s| s.0 == TOGGLE_ON);
                return Ok(format!(
                    "toggled {label} (now {})",
                    if on { "on" } else { "off" }
                ));
            }
            if facts.selected.is_some() {
                pattern::<IUIAutomationSelectionItemPattern>(
                    element,
                    UIA_SelectionItemPatternId,
                    "selection",
                )?
                .Select()
                .map_err(|e| stale_or(e, "selection"))?;
                return Ok(format!("selected {label}"));
            }
            if let Some(state) = facts.expand.filter(|s| *s != outline::LEAF) {
                let expand = pattern::<IUIAutomationExpandCollapsePattern>(
                    element,
                    UIA_ExpandCollapsePatternId,
                    "expand",
                )?;
                return if state == outline::EXPANDED {
                    expand.Collapse().map_err(|e| stale_or(e, "collapse"))?;
                    Ok(format!("collapsed {label}"))
                } else {
                    expand.Expand().map_err(|e| stale_or(e, "expand"))?;
                    Ok(format!("expanded {label}"))
                };
            }
            if facts.default_action.is_some() {
                pattern::<IUIAutomationLegacyIAccessiblePattern>(
                    element,
                    UIA_LegacyIAccessiblePatternId,
                    "press",
                )?
                .DoDefaultAction()
                .map_err(|e| stale_or(e, "press"))?;
                return Ok(format!("pressed {label}"));
            }
        }
        if outline::is_text_input(&facts) {
            self.session.agent_focus = Some(id);
            if self.in_front() {
                let _ = unsafe { element.SetFocus() };
            }
            return Ok(format!("focused {label} (ready for type)"));
        }
        if self.in_front() {
            let point = self.center(element, &label)?;
            self.uncovered(point)?;
            input::click(point, Button::Left, 1, &[], Duration::ZERO)?;
            return Ok(format!("clicked {label}"));
        }
        if facts.focusable {
            self.session.agent_focus = Some(id);
            return Ok(format!(
                "focused {label}; it has no click action, so nothing else happened"
            ));
        }
        Err(CuError::new(
            "not_clickable",
            format!("{label} has nothing UI Automation can press, and the window is in the background. Add activate first to click it by position, or pick another element."),
        ))
    }

    fn click(&mut self, step: &Step) -> CuResult<String> {
        let button = match text(step, "button").unwrap_or("left") {
            "right" => Button::Right,
            "middle" => Button::Middle,
            _ => Button::Left,
        };
        let count = int(step, "count").unwrap_or(1).clamp(1, 3) as u32;
        let mods = modifiers(step)?;
        let held = hold(step);
        let plain = mods.is_empty() && held.is_zero();
        if step.get("id").is_none() {
            let (x, y) = (
                number(step, "x")
                    .ok_or_else(|| CuError::new("bad_action", "click needs id or x,y."))?,
                number(step, "y")
                    .ok_or_else(|| CuError::new("bad_action", "click needs both x and y."))?,
            );
            let (point, window) = self.screen_point(x, y)?;
            if plain && button == Button::Left && count == 1 {
                if let Some(id) =
                    outline::hit(&self.session.nodes, window.0, window.1).map(|n| n.id)
                {
                    if let Ok(element) = self.session.element(id) {
                        if !self.in_front() {
                            let done = self.press(id, &element)?;
                            return Ok(format!("{done} (at {x},{y})"));
                        }
                    }
                }
            }
            self.front("A click by position")?;
            self.uncovered(point)?;
            input::click(point, button, count, &mods, held)?;
            return Ok(format!("clicked at {x},{y}"));
        }
        let (id, element) = self.target(step)?;
        let label = self.label(id);
        if plain && button == Button::Left && count == 1 {
            return self.press(id, &element);
        }
        if plain && button == Button::Right && count == 1 {
            if let Ok(element3) = element.cast::<IUIAutomationElement3>() {
                if unsafe { element3.ShowContextMenu() }.is_ok() {
                    return Ok(format!("opened the context menu of {label}"));
                }
            }
        }
        if plain && button == Button::Left && count == 2 && !self.in_front() {
            let fresh = self.uia.refresh(&element)?;
            if uia::facts(&fresh).default_action.is_some() {
                unsafe {
                    pattern::<IUIAutomationLegacyIAccessiblePattern>(
                        &element,
                        UIA_LegacyIAccessiblePatternId,
                        "double-click",
                    )?
                    .DoDefaultAction()
                    .map_err(|e| stale_or(e, "double-click"))?;
                }
                return Ok(format!("opened {label} (its default action)"));
            }
        }
        self.front("This click")?;
        let point = self.center(&element, &label)?;
        self.uncovered(point)?;
        input::click(point, button, count, &mods, held)?;
        let what = match (button, count) {
            (Button::Right, _) => "right-clicked",
            (Button::Middle, _) => "middle-clicked",
            (_, 2) => "double-clicked",
            (_, 3) => "triple-clicked",
            _ => "clicked",
        };
        Ok(format!("{what} {label}"))
    }

    fn move_pointer(&mut self, step: &Step) -> CuResult<String> {
        self.front("Hovering")?;
        let (point, place) = if step.get("id").is_some() {
            let (id, element) = self.target(step)?;
            let label = self.label(id);
            (self.center(&element, &label)?, label)
        } else {
            let (x, y) = (
                number(step, "x").unwrap_or(0.0),
                number(step, "y").unwrap_or(0.0),
            );
            (self.screen_point(x, y)?.0, format!("{x},{y}"))
        };
        self.uncovered(point)?;
        input::pointer_move(point)?;
        Ok(format!("moved the pointer to {place}"))
    }

    fn endpoint(&self, value: Option<&Value>) -> CuResult<((i32, i32), String)> {
        match value {
            Some(Value::Array(pair)) if pair.len() == 2 => {
                let (x, y) = (
                    pair[0].as_f64().unwrap_or(-1.0),
                    pair[1].as_f64().unwrap_or(-1.0),
                );
                Ok((self.screen_point(x, y)?.0, format!("{x},{y}")))
            }
            Some(Value::Object(object)) => {
                let id = object.get("id").and_then(Value::as_u64).ok_or_else(|| {
                    CuError::new("bad_action", "A drag end is [x, y] or {\"id\": n}.")
                })?;
                let label = self.label(id);
                Ok((self.center(&self.session.element(id)?, &label)?, label))
            }
            _ => Err(CuError::new(
                "bad_action",
                "drag needs from and to: [x, y] or {\"id\": n}.",
            )),
        }
    }

    fn drag(&mut self, step: &Step) -> CuResult<String> {
        self.front("Dragging")?;
        let (from, from_label) = self.endpoint(step.get("from"))?;
        let (to, to_label) = self.endpoint(step.get("to"))?;
        self.uncovered(from)?;
        input::drag(from, to, &modifiers(step)?, hold(step))?;
        Ok(format!("dragged from {from_label} to {to_label}"))
    }

    fn focus(&mut self, step: &Step) -> CuResult<String> {
        let (id, element) = self.target(step)?;
        let label = self.label(id);
        self.session.agent_focus = Some(id);
        if self.in_front() {
            unsafe { element.SetFocus() }.map_err(|e| stale_or(e, "focus"))?;
            return Ok(format!("focused {label}"));
        }
        Ok(format!(
            "focused {label} for the next steps (the window stays in the background)"
        ))
    }

    fn named_action(&mut self, step: &Step) -> CuResult<String> {
        let (id, element) = self.target(step)?;
        let label = self.label(id);
        let name = text(step, "name").unwrap_or_default().trim().to_owned();
        let fresh = self.uia.refresh(&element)?;
        let facts = uia::facts(&fresh);
        let wanted = name.to_lowercase();
        unsafe {
            match wanted.as_str() {
                "expand" | "collapse" if facts.expand.is_some() => {
                    let expand = pattern::<IUIAutomationExpandCollapsePattern>(
                        &element,
                        UIA_ExpandCollapsePatternId,
                        &wanted,
                    )?;
                    let done = if wanted == "expand" {
                        expand.Expand().map(|_| "expanded")
                    } else {
                        expand.Collapse().map(|_| "collapsed")
                    }
                    .map_err(|e| stale_or(e, &wanted))?;
                    return Ok(format!("{done} {label}"));
                }
                "select" | "add to selection" if facts.selected.is_some() => {
                    let item = pattern::<IUIAutomationSelectionItemPattern>(
                        &element,
                        UIA_SelectionItemPatternId,
                        "selection",
                    )?;
                    if wanted == "select" {
                        item.Select()
                    } else {
                        item.AddToSelection()
                    }
                    .map_err(|e| stale_or(e, "selection"))?;
                    return Ok(format!("selected {label}"));
                }
                "toggle" if facts.toggle.is_some() => {
                    pattern::<IUIAutomationTogglePattern>(&element, UIA_TogglePatternId, "toggle")?
                        .Toggle()
                        .map_err(|e| stale_or(e, "toggle"))?;
                    return Ok(format!("toggled {label}"));
                }
                "invoke" | "press" | "click" if facts.invoke => {
                    pattern::<IUIAutomationInvokePattern>(&element, UIA_InvokePatternId, "press")?
                        .Invoke()
                        .map_err(|e| stale_or(e, "press"))?;
                    return Ok(format!("pressed {label}"));
                }
                "show menu" | "show context menu" | "context menu" => {
                    let element3 = element
                        .cast::<IUIAutomationElement3>()
                        .map_err(|e| stale_or(e, "context menu"))?;
                    element3
                        .ShowContextMenu()
                        .map_err(|e| stale_or(e, "context menu"))?;
                    return Ok(format!("opened the context menu of {label}"));
                }
                "scroll into view" if facts.scroll_item => {
                    pattern::<IUIAutomationScrollItemPattern>(
                        &element,
                        UIA_ScrollItemPatternId,
                        "scroll",
                    )?
                    .ScrollIntoView()
                    .map_err(|e| stale_or(e, "scroll"))?;
                    return Ok(format!("scrolled {label} into view"));
                }
                _ => {}
            }
            if facts
                .default_action
                .as_deref()
                .is_some_and(|action| action.trim().eq_ignore_ascii_case(&name))
            {
                pattern::<IUIAutomationLegacyIAccessiblePattern>(
                    &element,
                    UIA_LegacyIAccessiblePatternId,
                    &wanted,
                )?
                .DoDefaultAction()
                .map_err(|e| stale_or(e, &wanted))?;
                return Ok(format!("performed \"{name}\" on {label}"));
            }
        }
        let mut listed = outline::readable_actions(&facts);
        if outline::is_actionable(&facts) {
            listed.insert(0, "press (click it)".into());
        }
        Err(CuError::new(
            "unknown_action",
            format!(
                "{label} has no action \"{name}\". {}",
                if listed.is_empty() {
                    "It lists no actions.".to_owned()
                } else {
                    format!("Its actions: {}.", listed.join(", "))
                }
            ),
        ))
    }

    fn scroll_to(&mut self, step: &Step) -> CuResult<String> {
        let (id, element) = self.target(step)?;
        let label = self.label(id);
        unsafe {
            pattern::<IUIAutomationScrollItemPattern>(&element, UIA_ScrollItemPatternId, "scroll")
                .map_err(|_| {
                    CuError::new(
                        "not_scrollable",
                        format!("{label} can't be scrolled into view through UI Automation. Scroll its list instead."),
                    )
                })?
                .ScrollIntoView()
                .map_err(|e| stale_or(e, "scroll"))?;
        }
        Ok(format!("scrolled {label} into view"))
    }

    fn wait_for(&mut self, step: &Step) -> CuResult<String> {
        let mut object = Map::new();
        for key in ["text", "id", "gone"] {
            if let Some(value) = step.get(key) {
                object.insert(key.into(), value.clone());
            }
        }
        let condition: Condition = conditions::condition(Some(&Value::Object(object)))?
            .ok_or_else(|| CuError::new("bad_action", "wait_for needs text or id."))?;
        let timeout = int(step, "timeout_ms").unwrap_or(5_000).clamp(100, 15_000) as u64;
        let started = Instant::now();
        loop {
            let nodes = self.refresh();
            if conditions::holds(&condition, &nodes) {
                return Ok(format!(
                    "waited {} ms for {}",
                    started.elapsed().as_millis(),
                    conditions::phrase(&condition)
                ));
            }
            if started.elapsed() >= Duration::from_millis(timeout) {
                return Err(CuError::new(
                    "wait_timeout",
                    format!("Waited {timeout} ms for {}, and it did not happen. Look again to see what the window shows.", conditions::phrase(&condition)),
                ));
            }
            self.activity
                .pause(Duration::from_millis(150), self.check)?;
        }
    }

    fn menu(&mut self, step: &Step) -> CuResult<String> {
        let path: Vec<String> = step
            .get("path")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        if path.is_empty() {
            return Err(CuError::new(
                "bad_action",
                "menu needs a path such as [\"File\", \"Save\"].",
            ));
        }
        let hwnd = self.session.hwnd()?;
        match super::menus::choose(hwnd, &path) {
            Ok((command, shown)) => {
                super::menus::post_command(hwnd, command)?;
                Ok(format!("chose {}", shown.join(" › ")))
            }
            Err(error) if error.code == "no_menu_bar" => {
                self.element_menu(&path).map_err(
                    |e| {
                        if e.code == "menu_not_found" {
                            e
                        } else {
                            error
                        }
                    },
                )
            }
            Err(error) => Err(error),
        }
    }

    /// Menus drawn by the app's toolkit (WinForms, WPF, WinUI): open each level by UI
    /// Automation and press the last item.
    fn element_menu(&mut self, path: &[String]) -> CuResult<String> {
        let mut shown = Vec::new();
        for (depth, wanted) in path.iter().enumerate() {
            let nodes = self.refresh();
            let key = super::text_match::menu_key(wanted);
            let titles: Vec<(u64, String)> = nodes
                .iter()
                .filter(|n| matches!(n.role.as_str(), "menu bar item" | "menu item"))
                .filter_map(|n| n.name.clone().map(|name| (n.id, name)))
                .collect();
            let found = titles
                .iter()
                .find(|(_, name)| super::text_match::menu_key(name) == key)
                .or_else(|| {
                    let mut prefixed = titles
                        .iter()
                        .filter(|(_, name)| super::text_match::menu_key(name).starts_with(&key));
                    match (prefixed.next(), prefixed.next()) {
                        (Some(only), None) => Some(only),
                        _ => None,
                    }
                })
                .ok_or_else(|| {
                    CuError::new(
                        "menu_not_found",
                        format!(
                            "No menu item \"{wanted}\" is showing. Visible menu items: {}.",
                            titles
                                .iter()
                                .map(|(_, n)| clip(n, 40).unwrap_or_default())
                                .collect::<Vec<_>>()
                                .join(", ")
                        ),
                    )
                })?
                .clone();
            shown.push(found.1.clone());
            let element = self.session.element(found.0)?;
            let last = depth + 1 == path.len();
            let fresh = self.uia.refresh(&element)?;
            let facts = uia::facts(&fresh);
            unsafe {
                if !last && facts.expand.is_some() {
                    pattern::<IUIAutomationExpandCollapsePattern>(
                        &element,
                        UIA_ExpandCollapsePatternId,
                        "menu",
                    )?
                    .Expand()
                    .map_err(|e| stale_or(e, "menu"))?;
                } else {
                    self.press(found.0, &element)?;
                }
            }
            self.activity.begin();
            self.activity.settle(&timing::BETWEEN_STEPS, self.check)?;
        }
        Ok(format!("chose {}", shown.join(" › ")))
    }
}
