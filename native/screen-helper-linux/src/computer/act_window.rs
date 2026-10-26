//! Window operations. Wayland compositors let no other program manage windows, so only what the
//! app's own accessible window actions offer works (GTK4 lists `window.close`,
//! `window.minimize`, `window.toggle-maximized`).
use crate::computer::act::{Actor, Step, text};
use crate::computer::element;
use crate::computer::error::{CuError, CuResult};

impl Actor<'_> {
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
        let names: &[&str] = match op.as_str() {
            "close" => &["window.close", "win.close"],
            "minimize" => &["window.minimize"],
            "zoom" => &["window.toggle-maximized"],
            "fullscreen" => &["win.fullscreen", "win.toggle-fullscreen"],
            "restore" | "raise" | "move" | "resize" => &[],
            _ => {
                return Err(CuError::new(
                    "bad_action",
                    "window op is close, minimize, restore, zoom, fullscreen, raise, move or resize.",
                ));
            }
        };
        if self.window_action(names).await? {
            let title = if window.title.is_empty() {
                String::new()
            } else {
                format!(
                    " \"{}\"",
                    crate::computer::error::clip(&window.title, 60).unwrap_or_default()
                )
            };
            return Ok(format!("asked the window{title} to {op}"));
        }
        Err(CuError::new(
            "not_supported",
            format!(
                "window {op} is not available: Wayland compositors do not let other programs manage windows. Ask the person, or use the app's own menu."
            ),
        ))
    }

    /// Last resort: asks the app's window to come to the front. This takes focus from the person.
    pub async fn activate(&mut self) -> CuResult<String> {
        let name = self.session.name.clone();
        let Some(window) = self.session.window.clone() else {
            return Err(CuError::new(
                "no_window",
                format!("{name} has no open window to bring forward."),
            ));
        };
        let _ = element::grab_focus(self.bus, &window.obj).await;
        self.changed();
        Ok(format!(
            "asked {name} to come to the front; Wayland compositors often refuse, so it may stay behind (raw keys and clicks still can't be sent there)"
        ))
    }
}
