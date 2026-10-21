//! Raw input: pointer clicks at a point, hover, drags, wheel scrolls and key presses. Linux
//! can't post input to a background window, so these go through XTest and only while the
//! target window is the active one. Scrolling an element by id moves its scroll bar through
//! AT-SPI instead, which works in the background.
use crate::computer::act::{Actor, Step, int, text};
use crate::computer::bus::Obj;
use crate::computer::element::{self, COORD_WINDOW};
use crate::computer::error::{CuError, CuResult};
use crate::computer::events::pause;
use crate::computer::keys::{self, Chord};
use serde_json::Value;

impl Actor<'_> {
    /// The target's X window when it is the active window; otherwise why raw input can't go.
    pub fn foreground(&self, step: &str) -> CuResult<u32> {
        let name = &self.session.name;
        let Some(x) = self.x else {
            return Err(CuError::new(
                "not_supported",
                format!(
                    "{step} needs real keyboard or pointer input, which this Wayland session does not let ace send to {name}. Use element ids instead: click {{id}}, type {{text, id}}, set_value, action or menu."
                ),
            ));
        };
        let xid = self
            .session
            .x_window(x)
            .ok_or_else(|| CuError::new("no_window", format!("{name} has no open window to receive input.")))?;
        if x.active_window() != Some(xid) {
            return Err(CuError::new(
                "not_on_screen",
                format!(
                    "{step} sends real input, which on Linux only reaches the active window, and {name} is in the background. Add an activate step before it (that brings {name} to the front), or use an element id (click {{id}}, type {{text, id}}, set_value, action, menu)."
                ),
            ));
        }
        Ok(xid)
    }

    fn display(&self) -> CuResult<&crate::computer::xdisplay::XDisplay> {
        self.x.ok_or_else(|| CuError::new("not_supported", "No X11 display."))
    }

    /// Screen position of a point in window pixels.
    fn screen_point(&self, xid: u32, point: (f64, f64)) -> CuResult<(i32, i32)> {
        let (wx, wy, ..) = self
            .display()?
            .geometry(xid)
            .ok_or_else(|| CuError::new("window_gone", "The window closed. Observe the app again."))?;
        Ok((wx + point.0.round() as i32, wy + point.1.round() as i32))
    }

    /// A screenshot pixel as a window pixel.
    fn window_point(&self, x: f64, y: f64) -> (f64, f64) {
        let scale = if self.session.scale > 0.0 {
            self.session.scale
        } else {
            1.0
        };
        (x / scale, y / scale)
    }

    fn modifier_codes(&self, step: &Step) -> CuResult<Vec<u8>> {
        let mut codes = Vec::new();
        for name in step
            .get("modifiers")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if name == "fn" {
                continue;
            }
            let chord = keys::parse_chord(&format!("{name}+a"))?;
            for symbol in chord.modifiers {
                codes.push(self.display()?.keycode(symbol)?.0);
            }
        }
        Ok(codes)
    }

    pub async fn raw_click(&mut self, step: &Step) -> CuResult<String> {
        let (Some(x), Some(y)) = (
            step.get("x").and_then(Value::as_f64),
            step.get("y").and_then(Value::as_f64),
        ) else {
            return Err(CuError::new(
                "bad_action",
                "click needs an element id, or x and y from a screenshot.",
            ));
        };
        let point = self.window_point(x, y);
        self.click_window_point(step, point, None).await
    }

    pub async fn click_window_point(
        &mut self,
        step: &Step,
        point: (f64, f64),
        label: Option<&str>,
    ) -> CuResult<String> {
        let xid = self.foreground("click")?;
        let (sx, sy) = self.screen_point(xid, point)?;
        let x = self.display()?;
        let button = match text(step, "button").unwrap_or("left") {
            "left" => 1,
            "middle" => 2,
            "right" => 3,
            _ => return Err(CuError::new("bad_action", "button is left, right or middle.")),
        };
        let count = int(step, "count").unwrap_or(1).clamp(1, 3);
        let hold = int(step, "hold_ms").unwrap_or(0).clamp(0, 5000) as u64;
        let modifiers = self.modifier_codes(step)?;
        x.motion(sx, sy)?;
        for code in &modifiers {
            x.key(*code, true)?;
        }
        let mut result = Ok(());
        for _ in 0..count {
            result = x.button(button, true).and_then(|_| x.flush());
            if result.is_err() {
                break;
            }
            if hold > 0 {
                pause(hold, self.check).await.ok();
            }
            result = x.button(button, false).and_then(|_| x.flush());
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        }
        for code in modifiers.iter().rev() {
            let _ = x.key(*code, false);
        }
        x.flush()?;
        result?;
        self.changed();
        let kind = match (button, count) {
            (3, _) => "right-",
            (2, _) => "middle-",
            (_, 2) => "double-",
            (_, 3) => "triple-",
            _ => "",
        };
        let over = label.map(|l| format!(" over {l}")).unwrap_or_default();
        Ok(format!("{kind}clicked at the point{over}"))
    }

    fn node_center(&self, id: u64) -> CuResult<(f64, f64)> {
        let frame = self
            .session
            .nodes
            .iter()
            .find(|n| n.id == id)
            .and_then(|n| n.frame)
            .ok_or_else(|| {
                CuError::new(
                    "not_clickable",
                    format!(
                        "{} has no position on screen. Observe again, or use an action on it.",
                        self.label(id)
                    ),
                )
            })?;
        Ok((frame.x + frame.w / 2.0, frame.y + frame.h / 2.0))
    }

    fn endpoint(&self, value: Option<&Value>, name: &str) -> CuResult<(f64, f64)> {
        match value {
            Some(Value::Array(pair)) if pair.len() == 2 => {
                let x = pair[0].as_f64().unwrap_or(0.0);
                let y = pair[1].as_f64().unwrap_or(0.0);
                Ok(self.window_point(x, y))
            }
            Some(Value::Object(object)) => match object.get("id").and_then(Value::as_u64) {
                Some(id) => self.node_center(id),
                None => Err(CuError::new(
                    "bad_action",
                    format!("drag needs {name} as [x, y] screenshot pixels or {{\"id\": n}}."),
                )),
            },
            _ => Err(CuError::new(
                "bad_action",
                format!("drag needs {name} as [x, y] screenshot pixels or {{\"id\": n}}."),
            )),
        }
    }

    pub async fn move_pointer(&mut self, step: &Step) -> CuResult<String> {
        let point = match step.get("id").and_then(Value::as_u64) {
            Some(id) => self.node_center(id)?,
            None => match (
                step.get("x").and_then(Value::as_f64),
                step.get("y").and_then(Value::as_f64),
            ) {
                (Some(x), Some(y)) => self.window_point(x, y),
                _ => {
                    return Err(CuError::new(
                        "bad_action",
                        "move needs an element id, or x and y from a screenshot.",
                    ));
                }
            },
        };
        let xid = self.foreground("move")?;
        let (sx, sy) = self.screen_point(xid, point)?;
        let x = self.display()?;
        x.motion(sx, sy)?;
        x.flush()?;
        self.changed();
        Ok("moved the pointer".into())
    }

    pub async fn drag(&mut self, step: &Step) -> CuResult<String> {
        let from = self.endpoint(step.get("from"), "from")?;
        let to = self.endpoint(step.get("to"), "to")?;
        let xid = self.foreground("drag")?;
        let start = self.screen_point(xid, from)?;
        let end = self.screen_point(xid, to)?;
        let modifiers = self.modifier_codes(step)?;
        let hold = int(step, "hold_ms").unwrap_or(0).clamp(0, 5000) as u64;
        let x = self.display()?;
        x.motion(start.0, start.1)?;
        for code in &modifiers {
            x.key(*code, true)?;
        }
        x.button(1, true)?;
        x.flush()?;
        pause(hold.max(60), self.check).await.ok();
        for i in 1..=12 {
            let t = f64::from(i) / 12.0;
            let px = start.0 as f64 + (end.0 - start.0) as f64 * t;
            let py = start.1 as f64 + (end.1 - start.1) as f64 * t;
            x.motion(px.round() as i32, py.round() as i32)?;
            x.flush()?;
            tokio::time::sleep(std::time::Duration::from_millis(15)).await;
        }
        x.button(1, false)?;
        for code in modifiers.iter().rev() {
            let _ = x.key(*code, false);
        }
        x.flush()?;
        self.changed();
        Ok(format!(
            "dragged from ({}, {}) to ({}, {})",
            from.0.round(),
            from.1.round(),
            to.0.round(),
            to.1.round()
        ))
    }

    pub async fn send_chord(&self, _xid: u32, chord: &Chord, repeat: usize, hold: u64) -> CuResult<()> {
        let x = self.display()?;
        let (code, shift) = x.keycode(chord.keysym)?;
        let mut modifiers = Vec::new();
        for symbol in &chord.modifiers {
            modifiers.push(x.keycode(*symbol)?.0);
        }
        if shift && !chord.modifiers.contains(&keys::SHIFT) {
            modifiers.push(x.keycode(keys::SHIFT)?.0);
        }
        let mut result = Ok(());
        for _ in 0..repeat {
            if let Err(error) = self.check.check() {
                result = Err(error);
                break;
            }
            for code in &modifiers {
                x.key(*code, true)?;
            }
            x.key(code, true)?;
            x.flush()?;
            if hold > 0 {
                pause(hold, self.check).await.ok();
            }
            x.key(code, false)?;
            for code in modifiers.iter().rev() {
                x.key(*code, false)?;
            }
            x.flush()?;
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        x.restore_keymap();
        self.changed();
        result
    }

    pub async fn type_keys(&self, xid: u32, typed: &str) -> CuResult<()> {
        for (index, c) in typed.chars().enumerate() {
            let chord = Chord {
                keysym: keys::char_keysym(c),
                modifiers: Vec::new(),
                key: c.to_string(),
            };
            self.send_chord(xid, &chord, 1, 0).await?;
            if index % 10 == 9 {
                self.check.check()?;
            }
        }
        Ok(())
    }

    pub async fn scroll(&mut self, step: &Step) -> CuResult<String> {
        let direction = text(step, "direction").unwrap_or_default();
        if !["up", "down", "left", "right"].contains(&direction) {
            return Err(CuError::new("bad_action", "direction is up, down, left or right."));
        }
        let pages = step.get("pages").and_then(Value::as_f64);
        let pixels = step.get("pixels").and_then(Value::as_f64);
        if pages.is_some() && pixels.is_some() {
            return Err(CuError::new("bad_action", "scroll takes pages or pixels, not both."));
        }
        let at_point = step.get("x").is_some();
        if !at_point {
            let area = match step.get("id").and_then(Value::as_u64) {
                Some(id) => Some((id, self.session.element(self.bus, id).await?.obj)),
                None => self.first_scroll_area(),
            };
            if let Some((id, obj)) = area {
                if let Some(done) = self.scroll_by_bar(&obj, direction, pages, pixels).await {
                    return Ok(done.replace("{label}", &self.label(id)));
                }
            }
        }
        let point = match (
            step.get("x").and_then(Value::as_f64),
            step.get("y").and_then(Value::as_f64),
            step.get("id").and_then(Value::as_u64),
        ) {
            (Some(x), Some(y), _) => self.window_point(x, y),
            (_, _, Some(id)) => self.node_center(id)?,
            _ => {
                let (_, _, w, h) = self
                    .display()
                    .ok()
                    .and_then(|x| self.session.x_window(x).and_then(|xid| x.geometry(xid)))
                    .unwrap_or((0, 0, 0, 0));
                (f64::from(w) / 2.0, f64::from(h) / 2.0)
            }
        };
        let xid = self.foreground("scroll").map_err(|e| {
            CuError::new(
                e.code,
                format!("Found nothing scrollable through accessibility there. {}", e.message),
            )
        })?;
        let (sx, sy) = self.screen_point(xid, point)?;
        let x = self.display()?;
        let button = match direction {
            "up" => 4,
            "down" => 5,
            "left" => 6,
            _ => 7,
        };
        let clicks = pixels
            .map(|p| p / 40.0)
            .unwrap_or(pages.unwrap_or(1.0) * 8.0)
            .round()
            .clamp(1.0, 200.0) as u32;
        x.motion(sx, sy)?;
        for _ in 0..clicks {
            x.button(button, true)?;
            x.button(button, false)?;
        }
        x.flush()?;
        self.changed();
        Ok(format!(
            "scrolled {direction} {clicks} wheel steps with the mouse wheel"
        ))
    }

    fn first_scroll_area(&self) -> Option<(u64, Obj)> {
        let node = self.session.nodes.iter().find(|n| n.role == "scroll area")?;
        Some((node.id, self.session.ids.get(node.id)?.clone()))
    }

    /// Moves the scroll bar of a scroll area (or of the one around an element). The account
    /// has `{label}` for the caller to fill in.
    async fn scroll_by_bar(
        &self,
        start: &Obj,
        direction: &str,
        pages: Option<f64>,
        pixels: Option<f64>,
    ) -> Option<String> {
        let bus = self.bus;
        let mut pane = start.clone();
        for _ in 0..8 {
            if bus
                .atspi::<_, String>(&pane, "Accessible", "GetRoleName", &())
                .await
                .ok()?
                == "scroll pane"
            {
                break;
            }
            pane = element::parent(bus, &pane).await?;
        }
        let extent = element::extents(bus, &pane, COORD_WINDOW).await.ok().flatten()?;
        let vertical = matches!(direction, "up" | "down");
        for bar in bus.children(&pane).await.ok()? {
            let Ok(found) = element::read(bus, &bar).await else {
                continue;
            };
            if found.role != "scroll bar" || !found.interfaces.value {
                continue;
            }
            let Some(frame) = element::extents(bus, &bar, COORD_WINDOW).await.ok().flatten() else {
                continue;
            };
            if (frame.h > frame.w) != vertical {
                continue;
            }
            let current = element::current_value(bus, &bar).await.ok()?;
            let min = bus.f64_prop(&bar, "Value", "MinimumValue").await.ok()?;
            let max = bus.f64_prop(&bar, "Value", "MaximumValue").await.ok()?;
            let page = (if vertical { extent.h } else { extent.w }) * 0.9;
            let distance = pixels.unwrap_or_else(|| pages.unwrap_or(1.0) * page);
            let signed = if matches!(direction, "up" | "left") {
                -distance
            } else {
                distance
            };
            let target = (current + signed).clamp(min, max);
            if (target - current).abs() < 0.5 {
                return Some(format!(
                    "{{label}} already shows all its content; nothing to scroll {direction}"
                ));
            }
            bus.set_prop(&bar, "Value", "CurrentValue", zbus::zvariant::Value::from(target))
                .await
                .ok()?;
            self.changed();
            let percent = if max > min {
                ((target - min) / (max - min) * 100.0).round()
            } else {
                0.0
            };
            return Some(format!("scrolled {{label}} {direction} to {percent}%"));
        }
        None
    }
}
