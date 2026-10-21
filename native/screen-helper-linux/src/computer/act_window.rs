//! Window operations: EWMH on X11; on Wayland only what the app's own accessible window
//! actions offer (GTK4 lists `window.close`, `window.minimize`, `window.toggle-maximized`).
use crate::computer::act::{Actor, Step, int, text};
use crate::computer::element;
use crate::computer::error::{CuError, CuResult};
use crate::computer::events::pause;

impl Actor<'_> {
    fn frame_note(&self, xid: u32) -> String {
        match self.x.and_then(|x| x.geometry(xid)) {
            Some((x, y, w, h)) => format!("; it is now at ({x}, {y}), {w}×{h}"),
            None => String::new(),
        }
    }

    /// Runs one of the window's own accessible actions, when it has it.
    async fn window_action(&self, names: &[&str]) -> CuResult<bool> {
        let Some(window) = self.session.window.clone() else {
            return Ok(false);
        };
        let actions = element::action_names(self.bus, &window.obj).await.unwrap_or_default();
        let Some(index) = actions.iter().position(|a| names.contains(&a.as_str())) else {
            return Ok(false);
        };
        let element = element::read(self.bus, &window.obj)
            .await
            .map_err(|_| self.busy("window action"))?;
        self.perform(&element, index, &actions[index], "the window").await?;
        Ok(true)
    }

    pub async fn window_op(&mut self, step: &Step) -> CuResult<String> {
        let window = self
            .session
            .window
            .clone()
            .ok_or_else(|| CuError::new("no_window", format!("{} has no open window.", self.session.name)))?;
        let op = text(step, "op").unwrap_or_default().to_owned();
        let title = if window.title.is_empty() {
            String::new()
        } else {
            format!(
                " \"{}\"",
                crate::computer::error::clip(&window.title, 60).unwrap_or_default()
            )
        };
        let xid = self.x.and_then(|x| self.session.x_window(x).map(|xid| (x, xid)));
        let Some((x, xid)) = xid else {
            let names: &[&str] = match op.as_str() {
                "close" => &["window.close", "win.close"],
                "minimize" => &["window.minimize"],
                "zoom" => &["window.toggle-maximized"],
                "fullscreen" => &["win.fullscreen", "win.toggle-fullscreen"],
                _ => &[],
            };
            if self.window_action(names).await? {
                return Ok(format!("asked the window{title} to {op}"));
            }
            return Err(CuError::new(
                "not_supported",
                format!(
                    "window {op} is not available in this Wayland session: the compositor does not let other programs manage windows. Ask the person, or use the app's own menu."
                ),
            ));
        };
        let done = match op.as_str() {
            "close" => {
                x.close(xid)?;
                format!("closed the window{title} (if it has unsaved changes, the app now asks what to do)")
            }
            "minimize" => {
                x.minimize(xid)?;
                format!("minimized the window{title}")
            }
            "restore" => {
                x.set_state(xid, false, "_NET_WM_STATE_FULLSCREEN", None)?;
                x.map(xid)?;
                format!("restored the window{title}")
            }
            "zoom" => {
                let maximized = x.has_state(xid, "_NET_WM_STATE_MAXIMIZED_VERT");
                x.set_state(
                    xid,
                    !maximized,
                    "_NET_WM_STATE_MAXIMIZED_VERT",
                    Some("_NET_WM_STATE_MAXIMIZED_HORZ"),
                )?;
                pause(200, self.check).await?;
                format!(
                    "{} the window{title}{}",
                    if maximized { "unmaximized" } else { "maximized" },
                    self.frame_note(xid)
                )
            }
            "fullscreen" => {
                x.set_state(xid, true, "_NET_WM_STATE_FULLSCREEN", None)?;
                format!("put the window{title} in full screen (window restore leaves it)")
            }
            "raise" => {
                x.raise(xid)?;
                format!("raised the window{title} (the window manager may keep focus where it was)")
            }
            "move" => {
                let (Some(left), Some(top)) = (int(step, "x"), int(step, "y")) else {
                    return Err(CuError::new(
                        "bad_action",
                        "window move needs x and y in screen pixels (top-left origin).",
                    ));
                };
                x.move_resize(xid, Some((left as i32, top as i32)), None)?;
                pause(200, self.check).await?;
                format!("moved the window{title}{}", self.frame_note(xid))
            }
            "resize" => {
                let (Some(width), Some(height)) = (int(step, "width"), int(step, "height")) else {
                    return Err(CuError::new(
                        "bad_action",
                        "window resize needs width and height in pixels.",
                    ));
                };
                if width <= 0 || height <= 0 {
                    return Err(CuError::new(
                        "bad_action",
                        "window resize needs a positive width and height.",
                    ));
                }
                x.move_resize(xid, None, Some((width as u32, height as u32)))?;
                pause(200, self.check).await?;
                format!("resized the window{title}{}", self.frame_note(xid))
            }
            _ => {
                return Err(CuError::new(
                    "bad_action",
                    "window op is close, minimize, restore, zoom, fullscreen, raise, move or resize.",
                ));
            }
        };
        self.changed();
        Ok(done)
    }

    /// Last resort: brings the app's window to the front. This takes focus from the person.
    pub async fn activate(&mut self) -> CuResult<String> {
        let name = self.session.name.clone();
        let Some(window) = self.session.window.clone() else {
            return Err(CuError::new(
                "no_window",
                format!("{name} has no open window to bring forward."),
            ));
        };
        let Some((x, xid)) = self.x.and_then(|x| self.session.x_window(x).map(|xid| (x, xid))) else {
            let _ = element::grab_focus(self.bus, &window.obj).await;
            self.changed();
            return Ok(format!(
                "asked {name} to come to the front; Wayland compositors often refuse, so it may stay behind (raw keys and clicks still can't be sent there)"
            ));
        };
        if window.minimized {
            x.map(xid)?;
        }
        x.activate(xid)?;
        x.raise(xid)?;
        for _ in 0..10 {
            pause(50, self.check).await?;
            if x.active_window() == Some(xid) {
                break;
            }
        }
        self.changed();
        Ok(if x.active_window() == Some(xid) {
            format!("brought {name} to the front")
        } else {
            format!("asked {name} to come to the front; the window manager has not switched to it yet")
        })
    }
}
