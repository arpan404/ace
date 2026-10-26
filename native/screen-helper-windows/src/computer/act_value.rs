//! Steps that change an element's state through UI Automation patterns: set_value,
//! select_text and scroll. All of them work on windows in the background.
use super::act::{int, number, text, Actor, Step};
use super::error::{clip, CuError, CuResult};
use super::input;
use super::outline::{self, TOGGLE_ON};
use super::text_match::{find_text, occurrence_index, utf16_offset};
use super::uia::{self, pattern, stale_or};
use serde_json::Value;
use windows::core::BSTR;
use windows::Win32::{
    Foundation::*,
    UI::{Accessibility::*, Controls::EM_SETSEL, WindowsAndMessaging::*},
};

impl Actor<'_> {
    pub fn set_value(&mut self, step: &Step) -> CuResult<String> {
        let (id, element) = self.target(step)?;
        let label = self.label(id);
        let fresh = self.uia.refresh(&element)?;
        let facts = uia::facts(&fresh);
        if !facts.enabled {
            return Err(CuError::new(
                "action_failed",
                format!("{label} is disabled."),
            ));
        }
        let value = step
            .get("value")
            .ok_or_else(|| CuError::new("bad_action", "set_value needs a value."))?;
        unsafe {
            match value {
                Value::Bool(wanted) => {
                    if facts.toggle.is_some() {
                        let toggle = pattern::<IUIAutomationTogglePattern>(
                            &element,
                            UIA_TogglePatternId,
                            "toggle",
                        )?;
                        for _ in 0..3 {
                            let on = toggle
                                .CurrentToggleState()
                                .map_err(|e| stale_or(e, "toggle"))?
                                .0
                                == TOGGLE_ON;
                            if on == *wanted {
                                return Ok(format!(
                                    "set {label} {}",
                                    if on { "on" } else { "off" }
                                ));
                            }
                            toggle.Toggle().map_err(|e| stale_or(e, "toggle"))?;
                        }
                        return Err(CuError::new(
                            "action_failed",
                            format!(
                                "{label} did not stay {}.",
                                if *wanted { "on" } else { "off" }
                            ),
                        ));
                    }
                    if facts.selected.is_some() {
                        let item = pattern::<IUIAutomationSelectionItemPattern>(
                            &element,
                            UIA_SelectionItemPatternId,
                            "selection",
                        )?;
                        if *wanted {
                            item.Select()
                        } else {
                            item.RemoveFromSelection()
                        }
                        .map_err(|e| stale_or(e, "selection"))?;
                        return Ok(format!(
                            "{} {label}",
                            if *wanted { "selected" } else { "deselected" }
                        ));
                    }
                    if facts.expand.is_some_and(|s| s != outline::LEAF) {
                        let expand = pattern::<IUIAutomationExpandCollapsePattern>(
                            &element,
                            UIA_ExpandCollapsePatternId,
                            "expand",
                        )?;
                        if *wanted {
                            expand.Expand()
                        } else {
                            expand.Collapse()
                        }
                        .map_err(|e| stale_or(e, "expand"))?;
                        return Ok(format!(
                            "{} {label}",
                            if *wanted { "expanded" } else { "collapsed" }
                        ));
                    }
                }
                Value::Number(n) => {
                    let n = n.as_f64().unwrap_or(0.0);
                    if facts.range_value {
                        pattern::<IUIAutomationRangeValuePattern>(
                            &element,
                            UIA_RangeValuePatternId,
                            "value change",
                        )?
                        .SetValue(n)
                        .map_err(|e| stale_or(e, "value change"))?;
                        return Ok(format!("set {label} to {n}"));
                    }
                    if facts.value_writable == Some(true) {
                        return self.write_value(&element, &label, &n.to_string());
                    }
                }
                Value::String(wanted) => {
                    if facts.value_writable == Some(true) {
                        return self.write_value(&element, &label, wanted);
                    }
                    if facts.expand.is_some() || facts.control_type == outline::control::LIST {
                        return self.choose_item(&element, &label, wanted, facts.expand);
                    }
                    if facts.range_value {
                        if let Ok(n) = wanted.trim().parse::<f64>() {
                            pattern::<IUIAutomationRangeValuePattern>(
                                &element,
                                UIA_RangeValuePatternId,
                                "value change",
                            )?
                            .SetValue(n)
                            .map_err(|e| stale_or(e, "value change"))?;
                            return Ok(format!("set {label} to {n}"));
                        }
                    }
                }
                _ => {}
            }
        }
        Err(CuError::new(
            "not_settable",
            format!("{label} has no value UI Automation can set to {value}. Click it, or type into it instead."),
        ))
    }

    fn write_value(
        &mut self,
        element: &IUIAutomationElement,
        label: &str,
        value: &str,
    ) -> CuResult<String> {
        unsafe {
            let pattern =
                pattern::<IUIAutomationValuePattern>(element, UIA_ValuePatternId, "value change")?;
            if pattern.CurrentIsReadOnly().is_ok_and(|r| r.as_bool()) {
                return Err(CuError::new(
                    "not_settable",
                    format!("{label} is read-only."),
                ));
            }
            pattern
                .SetValue(&BSTR::from(value))
                .map_err(|e| stale_or(e, "value change"))?;
        }
        Ok(format!(
            "set {label} to \"{}\"",
            clip(value, 60).unwrap_or_default()
        ))
    }

    /// Chooses an item of a combo box or list by its text.
    fn choose_item(
        &mut self,
        element: &IUIAutomationElement,
        label: &str,
        wanted: &str,
        expand: Option<i32>,
    ) -> CuResult<String> {
        let find = |root: &IUIAutomationElement| -> Option<IUIAutomationElement> {
            unsafe {
                let all = root
                    .FindAllBuildCache(
                        TreeScope_Descendants,
                        &self.uia.api.CreateTrueCondition().ok()?,
                        &self.uia.one,
                    )
                    .ok()?;
                let length = all.Length().ok()?.min(2000);
                let key = wanted.trim().to_lowercase();
                let items: Vec<IUIAutomationElement> =
                    (0..length).filter_map(|i| all.GetElement(i).ok()).collect();
                let name = |e: &IUIAutomationElement| {
                    e.CachedName()
                        .map(|n| n.to_string().trim().to_lowercase())
                        .unwrap_or_default()
                };
                items
                    .iter()
                    .find(|e| name(e) == key)
                    .or_else(|| items.iter().find(|e| name(e).starts_with(&key)))
                    .cloned()
            }
        };
        let mut opened = false;
        let mut item = find(element);
        if item.is_none() && expand.is_some_and(|s| s != outline::EXPANDED) {
            unsafe {
                if let Ok(expander) = pattern::<IUIAutomationExpandCollapsePattern>(
                    element,
                    UIA_ExpandCollapsePatternId,
                    "expand",
                ) {
                    opened = expander.Expand().is_ok();
                }
            }
            self.activity.begin();
            self.activity
                .settle(&super::timing::BETWEEN_STEPS, self.check)?;
            item = find(element);
        }
        let item = item.ok_or_else(|| {
            CuError::new(
                "not_settable",
                format!("{label} has no item \"{}\". Look at its items (click it to open the list), then choose one.", clip(wanted, 60).unwrap_or_default()),
            )
        })?;
        unsafe {
            let chosen = item
                .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                    UIA_SelectionItemPatternId,
                )
                .and_then(|p| p.Select())
                .or_else(|_| {
                    item.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                        .and_then(|p| p.Invoke())
                });
            chosen.map_err(|e| stale_or(e, "choice"))?;
            if opened {
                if let Ok(expander) = element
                    .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(
                        UIA_ExpandCollapsePatternId,
                    )
                {
                    let _ = expander.Collapse();
                }
            }
        }
        Ok(format!(
            "chose \"{}\" in {label}",
            clip(wanted, 60).unwrap_or_default()
        ))
    }

    pub fn select_text(&mut self, step: &Step) -> CuResult<String> {
        let (id, element) = self.target(step)?;
        let label = self.label(id);
        let wanted = text(step, "text").unwrap_or_default();
        let prefix = text(step, "prefix");
        let suffix = text(step, "suffix");
        let cursor = text(step, "cursor");
        let missing = |whole: &str| {
            let count = whole.matches(wanted).count();
            CuError::new(
                "text_not_found",
                if count > 1 {
                    format!("\"{}\" occurs {count} times in {label}; add prefix or suffix to say which.", clip(wanted, 60).unwrap_or_default())
                } else {
                    format!("\"{}\" is not in {label}'s text (exactly as written). Look again and copy it from the outline.", clip(wanted, 60).unwrap_or_default())
                },
            )
        };
        let what = match cursor {
            Some("before") => format!(
                "put the caret before \"{}\" in {label}",
                clip(wanted, 60).unwrap_or_default()
            ),
            Some("after") => format!(
                "put the caret after \"{}\" in {label}",
                clip(wanted, 60).unwrap_or_default()
            ),
            _ => format!(
                "selected \"{}\" in {label}",
                clip(wanted, 60).unwrap_or_default()
            ),
        };
        unsafe {
            if let Ok(pattern) =
                element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
            {
                let document = pattern
                    .DocumentRange()
                    .map_err(|e| stale_or(e, "text read"))?;
                let whole = document
                    .GetText(200_000)
                    .map_err(|e| stale_or(e, "text read"))?
                    .to_string();
                let (start, _) =
                    find_text(wanted, &whole, prefix, suffix).ok_or_else(|| missing(&whole))?;
                let skip = occurrence_index(&whole, wanted, start);
                let search = document.Clone().map_err(|e| stale_or(e, "text search"))?;
                let needle = BSTR::from(wanted);
                let mut found = None;
                for index in 0..=skip {
                    let hit = search
                        .FindText(&needle, false, false)
                        .map_err(|_| missing(&whole))?;
                    if index < skip {
                        search
                            .MoveEndpointByRange(
                                TextPatternRangeEndpoint_Start,
                                &hit,
                                TextPatternRangeEndpoint_End,
                            )
                            .map_err(|e| stale_or(e, "text search"))?;
                    } else {
                        found = Some(hit);
                    }
                }
                let found = found.ok_or_else(|| missing(&whole))?;
                match cursor {
                    Some("before") => found.MoveEndpointByRange(
                        TextPatternRangeEndpoint_End,
                        &found,
                        TextPatternRangeEndpoint_Start,
                    ),
                    Some("after") => found.MoveEndpointByRange(
                        TextPatternRangeEndpoint_Start,
                        &found,
                        TextPatternRangeEndpoint_End,
                    ),
                    _ => Ok(()),
                }
                .map_err(|e| stale_or(e, "selection"))?;
                found.Select().map_err(|e| stale_or(e, "selection"))?;
                self.session.agent_focus = Some(id);
                return Ok(what);
            }
        }
        // Win32 edit controls without the Text pattern: offsets in UTF-16 units.
        let fresh = self.uia.refresh(&element)?;
        if let Some(hwnd) =
            uia::native_window(&fresh).filter(|_| uia::is_edit_class(&uia::class_name(&fresh)))
        {
            let whole = uia::facts(&fresh).value.unwrap_or_default();
            let (start, end) =
                find_text(wanted, &whole, prefix, suffix).ok_or_else(|| missing(&whole))?;
            let (start, end) = match cursor {
                Some("before") => (start, start),
                Some("after") => (end, end),
                _ => (start, end),
            };
            let (from, to) = (utf16_offset(&whole, start), utf16_offset(&whole, end));
            unsafe {
                SendMessageTimeoutW(
                    hwnd,
                    EM_SETSEL,
                    WPARAM(from),
                    LPARAM(to as isize),
                    SMTO_ABORTIFHUNG,
                    2_000,
                    None,
                );
            }
            self.session.agent_focus = Some(id);
            return Ok(what);
        }
        Err(CuError::new(
            "not_text",
            format!("{label} exposes no text to select. Click into it and use keys, or pick a text field from the outline."),
        ))
    }

    /// The nearest element, from `element` up, that scrolls in the direction.
    fn scroller(
        &self,
        mut element: IUIAutomationElement,
        vertical: bool,
    ) -> Option<(IUIAutomationElement, IUIAutomationScrollPattern)> {
        for _ in 0..32 {
            unsafe {
                if let Ok(pattern) =
                    element.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)
                {
                    let scrolls = if vertical {
                        pattern.CurrentVerticallyScrollable()
                    } else {
                        pattern.CurrentHorizontallyScrollable()
                    };
                    if scrolls.is_ok_and(|s| s.as_bool()) {
                        return Some((element, pattern));
                    }
                }
            }
            element = self.uia.parent(&element)?;
        }
        None
    }

    pub fn scroll(&mut self, step: &Step) -> CuResult<String> {
        let direction = text(step, "direction").unwrap_or("down");
        let vertical = matches!(direction, "up" | "down");
        let forward = matches!(direction, "down" | "right");
        let pixels = int(step, "pixels");
        let pages = number(step, "pages").unwrap_or(1.0).clamp(0.1, 20.0);
        let (start, place, point) = if step.get("id").is_some() {
            let (id, element) = self.target(step)?;
            let label = self.label(id);
            let point = self.center(&element, &label).ok();
            (element, label, point)
        } else if let (Some(x), Some(y)) = (number(step, "x"), number(step, "y")) {
            let (point, window) = self.screen_point(x, y)?;
            let hit = super::outline::hit(&self.session.nodes, window.0, window.1).map(|n| n.id);
            let element = match hit.and_then(|id| self.session.element(id).ok()) {
                Some(element) => element,
                None => self.root()?,
            };
            (element, format!("at {x},{y}"), Some(point))
        } else {
            // The largest list or document in the window, else the window itself.
            let largest = self
                .session
                .nodes
                .iter()
                .filter(|n| {
                    matches!(
                        n.role.as_str(),
                        "list" | "outline" | "table" | "document" | "text area"
                    )
                })
                .max_by(|a, b| {
                    let area = |n: &super::outline::Node| n.frame.map_or(0.0, |f| f.w * f.h);
                    area(a)
                        .partial_cmp(&area(b))
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|n| n.id);
            let element = match largest.and_then(|id| self.session.element(id).ok()) {
                Some(element) => element,
                None => self.root()?,
            };
            (element, "the window".to_owned(), None)
        };
        let amount = match pixels {
            Some(p) => format!("{p} px"),
            None if (pages - 1.0).abs() < f64::EPSILON => "1 page".into(),
            None => format!("{pages} pages"),
        };
        if let Some((scroller, pattern)) = self.scroller(start, vertical) {
            unsafe {
                let (percent, view) = if vertical {
                    (
                        pattern.CurrentVerticalScrollPercent(),
                        pattern.CurrentVerticalViewSize(),
                    )
                } else {
                    (
                        pattern.CurrentHorizontalScrollPercent(),
                        pattern.CurrentHorizontalViewSize(),
                    )
                };
                let (percent, view) = (
                    percent.unwrap_or(0.0),
                    view.unwrap_or(100.0).clamp(1.0, 100.0),
                );
                let size = scroller
                    .CurrentBoundingRectangle()
                    .map(|r| {
                        f64::from(if vertical {
                            r.bottom - r.top
                        } else {
                            r.right - r.left
                        })
                    })
                    .unwrap_or(0.0);
                let delta = match pixels {
                    Some(p) if size > 0.0 => p as f64 / size * view,
                    _ => pages * view,
                };
                let target = (percent + if forward { delta } else { -delta }).clamp(0.0, 100.0);
                if (target - percent).abs() < 0.01 {
                    let edge = match direction {
                        "down" => "bottom",
                        "up" => "top",
                        "left" => "left edge",
                        _ => "right edge",
                    };
                    return Ok(format!("{place} is already at its {edge}"));
                }
                let no_scroll = UIA_ScrollPatternNoScroll;
                let result = if vertical {
                    pattern.SetScrollPercent(no_scroll, target)
                } else {
                    pattern.SetScrollPercent(target, no_scroll)
                };
                result.map_err(|e| stale_or(e, "scroll"))?;
            }
            return Ok(format!("scrolled {place} {direction} {amount}"));
        }
        // No scroll pattern: the wheel, in front, or posted to the background window.
        let notches = match pixels {
            Some(p) => ((p as f64) / 40.0).ceil().max(1.0) as i32,
            None => (pages * 3.0).ceil().max(1.0) as i32,
        } * if forward { 1 } else { -1 };
        let hwnd = self.session.hwnd()?;
        let point = match point {
            Some(point) => point,
            None => {
                let frame = super::capture::frame(hwnd)
                    .ok_or_else(|| CuError::new("no_window", "The window has no size."))?;
                (
                    (frame.x + frame.w / 2.0) as i32,
                    (frame.y + frame.h / 2.0) as i32,
                )
            }
        };
        if self.in_front() {
            self.uncovered(point)?;
            input::wheel(point, !vertical, notches)?;
            return Ok(format!(
                "scrolled {place} {direction} {amount} (mouse wheel)"
            ));
        }
        let target = unsafe {
            WindowFromPoint(POINT {
                x: point.0,
                y: point.1,
            })
        };
        let target = if super::apps::pid_of(target) == super::apps::pid_of(hwnd) {
            target
        } else {
            hwnd
        };
        let message = if vertical {
            WM_MOUSEWHEEL
        } else {
            WM_MOUSEHWHEEL
        };
        let delta = if vertical {
            -notches * 120
        } else {
            notches * 120
        };
        let wparam = WPARAM((delta as i16 as u16 as usize) << 16);
        let lparam = LPARAM(
            (((point.1 as i16 as u16 as u32) << 16) | (point.0 as i16 as u16 as u32)) as isize,
        );
        unsafe { PostMessageW(target, message, wparam, lparam) }.map_err(|e| {
            CuError::new(
                "action_failed",
                format!("The scroll could not be sent: {e}"),
            )
        })?;
        Ok(format!("scrolled {place} {direction} {amount} (wheel sent to the window in the background; look to check)"))
    }

    /// The window's own element.
    pub fn root(&self) -> CuResult<IUIAutomationElement> {
        let hwnd = self.session.hwnd()?;
        unsafe {
            self.uia
                .api
                .ElementFromHandleBuildCache(hwnd, &self.uia.one)
        }
        .map_err(|e| stale_or(e, "read"))
    }
}
