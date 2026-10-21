//! Runs model steps against one app. Each returns a one-line account of what it did, so the
//! model knows which path was taken. Semantic steps go through AT-SPI and work on background
//! windows; raw input (act_input.rs) needs the window in front.
use crate::computer::bus::{Bus, BusError, Obj};
use crate::computer::cancel::Checkpoint;
use crate::computer::clipboard::Clipboard;
use crate::computer::conditions::{self, Condition};
use crate::computer::element::{self, Element};
use crate::computer::error::{CuError, CuResult, clip};
use crate::computer::events::{Activity, pause};
use crate::computer::outline::{self, Node};
use crate::computer::session::AppSession;
use crate::computer::text_match::{MenuChoice, choose_menu_item};
use crate::computer::xdisplay::XDisplay;
use serde_json::{Map, Value};
use std::time::{Duration, Instant};

pub type Step = Map<String, Value>;

pub struct Actor<'a> {
    pub bus: &'a Bus,
    pub x: Option<&'a XDisplay>,
    pub session: &'a mut AppSession,
    pub activity: &'a Activity,
    pub check: &'a Checkpoint,
    pub clipboard: &'a mut Option<Clipboard>,
}

pub fn int(step: &Step, key: &str) -> Option<i64> {
    step.get(key)
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
}

pub fn text<'s>(step: &'s Step, key: &str) -> Option<&'s str> {
    step.get(key).and_then(Value::as_str)
}

impl Actor<'_> {
    pub async fn run(&mut self, step: &Step) -> CuResult<String> {
        let kind = text(step, "type")
            .ok_or_else(|| CuError::new("bad_action", "Each action needs a type."))?
            .to_owned();
        if let Some(condition) = conditions::condition(step.get("when"))? {
            let nodes = self.refresh().await;
            if !conditions::holds(&condition, &nodes) {
                return Ok(format!("skipped {kind}: condition not met"));
            }
        }
        match kind.as_str() {
            "click" => self.click(step).await,
            "move" => self.move_pointer(step).await,
            "drag" => self.drag(step).await,
            "type" => self.type_text(step).await,
            "paste" => self.paste(step).await,
            "key" => self.key(step).await,
            "set_value" => self.set_value(step).await,
            "select_text" => self.select_text(step).await,
            "focus" => self.focus(step).await,
            "action" => self.named_action(step).await,
            "scroll" => self.scroll(step).await,
            "scroll_to" => self.scroll_to(step).await,
            "menu" => self.menu(step).await,
            "window" => self.window_op(step).await,
            "wait" => {
                let ms = int(step, "ms").unwrap_or(500).clamp(0, 10_000) as u64;
                pause(ms, self.check).await?;
                Ok(format!("waited {ms} ms"))
            }
            "wait_for" => self.wait_for(step).await,
            "activate" => self.activate().await,
            other => Err(CuError::new("bad_action", format!("Unknown action type \"{other}\"."))),
        }
    }

    /// A fresh walk of the chosen window, for conditions and waits.
    pub async fn refresh(&mut self) -> Vec<Node> {
        let frames = match self.x.and_then(|x| self.session.x_window(x).map(|xid| (x, xid))) {
            Some((x, xid)) => self.session.frame_map(self.bus, x, xid).await,
            None => None,
        };
        self.session.walk(self.bus, frames, Duration::from_secs(2)).await;
        self.session.nodes.clone()
    }

    pub fn changed(&self) {
        self.activity.mark(self.session.bus_name());
    }

    pub fn id(step: &Step) -> CuResult<u64> {
        step.get("id")
            .and_then(Value::as_u64)
            .ok_or_else(|| CuError::new("bad_action", "This action needs an element id."))
    }

    pub async fn target(&self, step: &Step) -> CuResult<(u64, Element)> {
        let id = Self::id(step)?;
        Ok((id, self.session.element(self.bus, id).await?))
    }

    pub fn label(&self, id: u64) -> String {
        self.session.label(id)
    }

    pub fn busy(&self, what: &str) -> CuError {
        CuError::new(
            "app_busy",
            format!(
                "{} did not answer the {what} (it may be busy or showing a modal dialog). It may still have taken effect: observe before retrying.",
                self.session.name
            ),
        )
    }

    /// Performs an action by index; a refusal or silence becomes a model-facing error.
    pub async fn perform(&self, element: &Element, index: usize, name: &str, label: &str) -> CuResult<()> {
        match element::do_action(self.bus, &element.obj, index).await {
            Ok(true) => {
                self.changed();
                Ok(())
            }
            Ok(false) => Err(CuError::new(
                "action_failed",
                format!("{} refused {name} on {label}.", self.session.name),
            )),
            Err(BusError::Timeout) => Err(self.busy(name)),
            Err(BusError::Failed(e)) => Err(CuError::new(
                "action_failed",
                format!("{} refused {name} on {label} ({e}).", self.session.name),
            )),
        }
    }

    async fn click(&mut self, step: &Step) -> CuResult<String> {
        if step.get("id").is_none() {
            return self.raw_click(step).await;
        }
        let (id, element) = self.target(step).await?;
        let label = self.label(id);
        let button = text(step, "button").unwrap_or("left");
        let count = int(step, "count").unwrap_or(1);
        let plain = step.get("modifiers").is_none() && step.get("hold_ms").is_none();
        let actions = if element.interfaces.action {
            element::action_names(self.bus, &element.obj).await.unwrap_or_default()
        } else {
            Vec::new()
        };
        if button == "right" && plain {
            if let Some(index) = actions
                .iter()
                .position(|a| matches!(a.as_str(), "menu.popup" | "popup" | "showmenu" | "show-menu"))
            {
                self.perform(&element, index, "context menu", &label).await?;
                return Ok(format!("opened the context menu of {label}"));
            }
        }
        if button == "left" && plain && count <= 2 {
            if count == 2 {
                if let Some(index) = actions.iter().position(|a| a == "activate") {
                    self.perform(&element, index, "activate", &label).await?;
                    return Ok(format!("opened {label}"));
                }
            }
            if let Some(index) = outline::press_action(&actions) {
                self.perform(&element, index, &actions[index], &label).await?;
                return Ok(format!("pressed {label}"));
            }
            if outline::is_text_input(&element.role, &element.states) && grab(self.bus, &element.obj).await {
                self.changed();
                return Ok(format!("focused {label} (ready for type)"));
            }
            if element.states.selectable && self.select_in_parent(&element).await {
                return Ok(format!("selected {label}"));
            }
        }
        if let Some(center) = self
            .session
            .nodes
            .iter()
            .find(|n| n.id == id)
            .and_then(|n| n.frame)
            .map(|f| (f.x + f.w / 2.0, f.y + f.h / 2.0))
        {
            if self.foreground("click").is_ok() {
                return self.click_window_point(step, center, Some(&label)).await;
            }
        }
        if element.states.focusable && plain && grab(self.bus, &element.obj).await {
            self.changed();
            return Ok(format!(
                "focused {label}; it has no click action, so nothing else happened"
            ));
        }
        self.foreground("click").map(|_| ())?;
        Err(CuError::new(
            "not_clickable",
            format!("{label} has no position to click. Try an action listed on it, a menu path, or the keyboard."),
        ))
    }

    async fn select_in_parent(&self, element: &Element) -> bool {
        let Some(parent) = element::parent(self.bus, &element.obj).await else {
            return false;
        };
        let Ok(index) = self
            .bus
            .atspi::<_, i32>(&element.obj, "Accessible", "GetIndexInParent", &())
            .await
        else {
            return false;
        };
        let selected = self
            .bus
            .atspi::<_, bool>(&parent, "Selection", "SelectChild", &(index,))
            .await
            .unwrap_or(false);
        if selected {
            self.changed();
        }
        selected
    }

    async fn focus(&mut self, step: &Step) -> CuResult<String> {
        let (id, element) = self.target(step).await?;
        let label = self.label(id);
        if !grab(self.bus, &element.obj).await {
            return Err(CuError::new(
                "action_failed",
                format!(
                    "{} would not focus {label}. Try clicking it instead.",
                    self.session.name
                ),
            ));
        }
        if element.interfaces.text {
            self.session.text_focus = Some(element.obj.clone());
        }
        self.changed();
        Ok(format!("focused {label}"))
    }

    async fn named_action(&mut self, step: &Step) -> CuResult<String> {
        let (id, element) = self.target(step).await?;
        let label = self.label(id);
        let wanted = text(step, "name")
            .filter(|n| !n.is_empty())
            .ok_or_else(|| CuError::new("bad_action", "action needs the action name shown on the element."))?;
        let names = element::action_names(self.bus, &element.obj)
            .await
            .map_err(|_| self.busy(wanted))?;
        let compact = |s: &str| s.to_lowercase().replace([' ', '-', '_'], "");
        let index = names
            .iter()
            .position(|n| n == wanted)
            .or_else(|| names.iter().position(|n| compact(n) == compact(wanted)));
        let Some(index) = index else {
            let offered = outline::readable_actions(&element.role, &names);
            let offered = if offered.is_empty() {
                "only a plain click".to_owned()
            } else {
                offered.join(", ")
            };
            return Err(CuError::new(
                "unknown_action",
                format!("{label} has no \"{wanted}\" action. It offers: {offered}."),
            ));
        };
        self.perform(&element, index, &names[index], &label).await?;
        Ok(format!("performed {} on {label}", names[index]))
    }

    async fn set_value(&mut self, step: &Step) -> CuResult<String> {
        let (id, element) = self.target(step).await?;
        let label = self.label(id);
        if element.role == "password text" {
            return Err(CuError::new(
                "secure_field",
                "That is a password field. Ask the person to fill it in themselves.",
            ));
        }
        let value = step
            .get("value")
            .ok_or_else(|| CuError::new("bad_action", "set_value needs a value (text, number or true/false)."))?;
        let not_settable = || {
            CuError::new(
                "not_settable",
                format!("{label}'s value can't be set directly. Click it and type, or use the keyboard."),
            )
        };
        if let Some(wanted) = value.as_bool() {
            let on = element.states.checked || element.states.pressed;
            if on != wanted {
                let actions = element::action_names(self.bus, &element.obj).await.unwrap_or_default();
                let index = outline::press_action(&actions).ok_or_else(not_settable)?;
                self.perform(&element, index, &actions[index], &label).await?;
            }
            return Ok(format!("set {label} {}", if wanted { "on" } else { "off" }));
        }
        let number = value
            .as_f64()
            .or_else(|| value.as_str().and_then(|s| s.trim().parse::<f64>().ok()));
        if element.interfaces.value && !element.interfaces.editable {
            let number = number.ok_or_else(|| CuError::new("bad_action", format!("{label} takes a number.")))?;
            self.bus
                .set_prop(
                    &element.obj,
                    "Value",
                    "CurrentValue",
                    zbus::zvariant::Value::from(number),
                )
                .await
                .map_err(|_| not_settable())?;
            self.changed();
            return Ok(format!("set {label}"));
        }
        if element.interfaces.editable {
            let text = value.as_str().map(str::to_owned).unwrap_or_else(|| value.to_string());
            let done = self
                .bus
                .atspi::<_, bool>(&element.obj, "EditableText", "SetTextContents", &(text.as_str(),))
                .await
                .map_err(|_| self.busy("new value"))?;
            if !done {
                return Err(CuError::new(
                    "action_failed",
                    format!("{} rejected the new value for {label}.", self.session.name),
                ));
            }
            self.changed();
            return Ok(format!("set {label}"));
        }
        Err(not_settable())
    }

    async fn select_text(&mut self, step: &Step) -> CuResult<String> {
        let (id, element) = self.target(step).await?;
        let label = self.label(id);
        let wanted = text(step, "text")
            .filter(|t| !t.is_empty())
            .ok_or_else(|| CuError::new("bad_action", "select_text needs the text to select."))?;
        if !element.interfaces.text {
            return Err(CuError::new("not_text", format!("{label} has no text to select.")));
        }
        let (full, _) = element::text_head(self.bus, &element.obj, 200_000)
            .await
            .map_err(|_| self.busy("selection"))?;
        let shown = clip(wanted, 40).unwrap_or_default();
        let Some((mut start, mut end)) =
            crate::computer::text_match::find_text(wanted, &full, text(step, "prefix"), text(step, "suffix"))
        else {
            let message = if full.contains(wanted) {
                format!(
                    "\"{shown}\" occurs more than once in {label} and prefix/suffix match none of them. Copy the surrounding text exactly."
                )
            } else {
                format!("\"{shown}\" is not in {label}. Copy the text exactly as the outline shows it.")
            };
            return Err(CuError::new("text_not_found", message));
        };
        match text(step, "cursor") {
            Some("after") => start = end,
            Some("before") => end = start,
            _ => {}
        }
        grab(self.bus, &element.obj).await;
        self.session.text_focus = Some(element.obj.clone());
        set_selection(self.bus, &element.obj, start as i32, end as i32)
            .await
            .map_err(|_| {
                CuError::new(
                    "action_failed",
                    format!("{} would not change the selection in {label}.", self.session.name),
                )
            })?;
        self.changed();
        Ok(if start == end {
            format!("placed the cursor in {label}")
        } else {
            format!("selected \"{shown}\" in {label}")
        })
    }

    async fn scroll_to(&mut self, step: &Step) -> CuResult<String> {
        let (id, element) = self.target(step).await?;
        let label = self.label(id);
        let moved = element.interfaces.component
            && self
                .bus
                .atspi::<_, bool>(&element.obj, "Component", "ScrollTo", &(6u32,))
                .await
                .unwrap_or(false);
        if !moved {
            return Err(CuError::new(
                "not_scrollable",
                format!("Could not bring {label} into view. Scroll its list with scroll, or use keys."),
            ));
        }
        self.changed();
        Ok(format!("scrolled {label} into view"))
    }

    async fn wait_for(&mut self, step: &Step) -> CuResult<String> {
        let condition = Condition {
            text: text(step, "text").filter(|t| !t.is_empty()).map(str::to_owned),
            id: step.get("id").and_then(Value::as_u64),
            gone: step.get("gone").and_then(Value::as_bool).unwrap_or(false),
        };
        if condition.text.is_none() && condition.id.is_none() {
            return Err(CuError::new("bad_action", "wait_for needs text or id."));
        }
        let timeout = int(step, "timeout_ms").unwrap_or(5000).clamp(100, 15_000) as u128;
        let started = Instant::now();
        loop {
            self.check.check()?;
            let nodes = self.refresh().await;
            if conditions::holds(&condition, &nodes) {
                return Ok(format!(
                    "waited {} ms for {}",
                    started.elapsed().as_millis(),
                    conditions::phrase(&condition)
                ));
            }
            if started.elapsed().as_millis() >= timeout {
                break;
            }
            self.activity
                .settle(
                    self.session.bus_name(),
                    Duration::from_millis(100),
                    Duration::from_millis(30),
                    Duration::from_millis(150),
                    self.check,
                )
                .await?;
        }
        Err(CuError::new(
            "wait_timeout",
            format!(
                "Waited {timeout} ms for {}, but it did not happen. Observe to see the current state, or wait longer.",
                conditions::phrase(&condition)
            ),
        ))
    }

    /// Presses a menu item by its path without opening the menu on screen.
    async fn menu(&mut self, step: &Step) -> CuResult<String> {
        let path: Vec<String> = step
            .get("path")
            .and_then(Value::as_array)
            .map(|p| p.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            .unwrap_or_default();
        if path.is_empty() || path.len() > 8 {
            return Err(CuError::new(
                "bad_action",
                "menu needs a path such as [\"File\", \"New Window\"].",
            ));
        }
        if self.session.menu_bar.is_none() {
            self.refresh().await;
        }
        let bar = self.session.menu_bar.clone().ok_or_else(|| {
            CuError::new("no_menu_bar", format!("{} has no menu bar. Its menus are buttons in the window (such as \"Main Menu\"): click one by id, then click the item in the outline.", self.session.name))
        })?;
        let mut container = bar;
        let mut trail: Vec<String> = Vec::new();
        for (index, wanted) in path.iter().enumerate() {
            self.check.check()?;
            let items = self.menu_items(&container).await;
            let titles: Vec<String> = items.iter().map(|(_, title)| title.clone()).collect();
            let place = if trail.is_empty() {
                "the menu bar".to_owned()
            } else {
                trail.join(" > ")
            };
            let (obj, title) = match choose_menu_item(&titles, wanted) {
                MenuChoice::Found(at) => items[at].clone(),
                MenuChoice::Ambiguous(matches) => {
                    return Err(CuError::new(
                        "menu_ambiguous",
                        format!(
                            "\"{wanted}\" matches several items in {place}: {}. Use the full title.",
                            matches.into_iter().take(12).collect::<Vec<_>>().join(", ")
                        ),
                    ));
                }
                MenuChoice::Missing => {
                    let listed: Vec<String> = titles.iter().take(40).map(|t| t.trim().to_owned()).collect();
                    return Err(CuError::new(
                        "menu_not_found",
                        format!("No \"{wanted}\" in {place}. Items: {}.", listed.join(", ")),
                    ));
                }
            };
            trail.push(title.trim().to_owned());
            if index == path.len() - 1 {
                let element = element::read(self.bus, &obj)
                    .await
                    .map_err(|_| self.busy("menu item"))?;
                if !element.states.sensitive {
                    return Err(CuError::new(
                        "menu_disabled",
                        format!(
                            "{} is disabled right now (nothing it applies to, or not allowed in this state).",
                            trail.join(" > ")
                        ),
                    ));
                }
                let actions = element::action_names(self.bus, &obj).await.unwrap_or_default();
                let action = outline::press_action(&actions).ok_or_else(|| {
                    CuError::new(
                        "action_failed",
                        format!("{} can't be chosen through accessibility.", trail.join(" > ")),
                    )
                })?;
                self.perform(&element, action, "menu item", &trail.join(" > ")).await?;
                return Ok(format!("chose {}", trail.join(" > ")));
            }
            container = obj;
        }
        Ok(format!("chose {}", trail.join(" > ")))
    }

    async fn menu_items(&self, container: &Obj) -> Vec<(Obj, String)> {
        let Ok(children) = self.bus.children(container).await else {
            return Vec::new();
        };
        let mut items = Vec::new();
        for child in children {
            let Ok(element) = element::read(self.bus, &child).await else {
                continue;
            };
            if element.role == "separator" || element.name.trim().is_empty() {
                // GTK nests some menus one level down, in an unnamed menu.
                if element.role == "menu" || element.role == "popup menu" {
                    items.extend(Box::pin(self.menu_items(&child)).await);
                }
                continue;
            }
            items.push((child, element.name));
        }
        items
    }
}

pub async fn grab(bus: &Bus, obj: &Obj) -> bool {
    element::grab_focus(bus, obj).await.unwrap_or(false)
}

pub async fn set_selection(bus: &Bus, obj: &Obj, start: i32, end: i32) -> Result<(), BusError> {
    if start == end {
        let _ = bus.atspi::<_, bool>(obj, "Text", "RemoveSelection", &(0i32,)).await;
        return bus
            .atspi::<_, bool>(obj, "Text", "SetCaretOffset", &(start,))
            .await
            .and_then(|ok| {
                if ok {
                    Ok(())
                } else {
                    Err(BusError::Failed("refused".into()))
                }
            });
    }
    let count = bus
        .atspi::<_, i32>(obj, "Text", "GetNSelections", &())
        .await
        .unwrap_or(0);
    let done = if count > 0 {
        bus.atspi::<_, bool>(obj, "Text", "SetSelection", &(0i32, start, end))
            .await?
    } else {
        bus.atspi::<_, bool>(obj, "Text", "AddSelection", &(start, end)).await?
    };
    if done {
        Ok(())
    } else {
        Err(BusError::Failed("refused".into()))
    }
}
