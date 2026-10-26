//! Raw input: pointer clicks at a point, hover, drags, wheel scrolls and keys with no text
//! equivalent. Wayland gives other programs no way to send input to an app's window, so these
//! are refused with the element-id steps that do work. Scrolling an element by id moves its
//! scroll bar through AT-SPI instead, which works in the background.
use crate::computer::act::{Actor, Step, text};
use crate::computer::bus::Obj;
use crate::computer::element::{self, COORD_WINDOW};
use crate::computer::error::{CuError, CuResult};
use serde_json::Value;

impl Actor<'_> {
    /// Why a step that needs real keyboard or pointer input can't run.
    pub fn raw_refused(&self, step: &str) -> CuError {
        CuError::new(
            "not_supported",
            format!(
                "{step} needs real keyboard or pointer input, which Wayland does not let ace send to {}. Use element ids instead: click {{id}}, type {{text, id}}, set_value, action or menu.",
                self.session.name
            ),
        )
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
        if step.get("x").is_none() {
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
        let refused = self.raw_refused("scroll");
        Err(CuError::new(
            refused.code,
            format!("Found nothing scrollable through accessibility there. {}", refused.message),
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
            if element::role(bus, &pane).await.ok()? == "scroll pane" {
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
