//! A person's input to a shared Wayland window goes to it only while it is in front.
//!
//! The portal's input lands wherever that point of the screen is, so a window behind another
//! app would hand the person's click to the app in front. Before their input, the window must
//! be the active one, as its accessibility says. If it isn't, the app is asked to come forward
//! (`org.freedesktop.Application.Activate`, which GNOME apps answer by presenting their
//! window); a desktop that refuses (GNOME keeps focus from apps without an activation token)
//! leaves it behind, and the input is refused with what to do instead.
use crate::{
    accessibility::Accessibility,
    protocol::{Fault, Result, internal},
};
use atspi::State;
use std::time::Duration;
use zbus::{Connection, zvariant::Value};

/// The D-Bus object path a GApplication exports for an application id.
pub fn application_path(app_id: &str) -> String {
    let mut path = String::from("/");
    for (index, c) in app_id.chars().enumerate() {
        match c {
            '.' => path.push('/'),
            '-' => path.push('_'),
            c if c.is_ascii_digit() && (index == 0 || app_id[..index].ends_with('.')) => {
                path.push('_');
                path.push(c);
            }
            c => path.push(c),
        }
    }
    path
}

impl Accessibility {
    /// Whether the scoped app's window is the active one.
    pub async fn window_active(&self) -> Result<bool> {
        let scope = self
            .scope
            .as_ref()
            .ok_or_else(|| Fault::new("not_supported", "No accessible window"))?;
        let window = self.proxy(scope, "Accessible").await?;
        let states: atspi::StateSet = window.call("GetState", &()).await.map_err(internal)?;
        Ok(states.contains(State::Active))
    }
}

/// Asks the app to bring its window forward; false when the bus or the app refuses.
pub(crate) async fn activate(app_id: &str) -> bool {
    let Ok(session) = Connection::session().await else {
        return false;
    };
    let platform: std::collections::HashMap<&str, Value> = std::collections::HashMap::new();
    session
        .call_method(
            Some(app_id),
            application_path(app_id).as_str(),
            Some("org.freedesktop.Application"),
            "Activate",
            &(platform,),
        )
        .await
        .is_ok()
}

/// The shared window is in front for the person's input, or the reason it can't be.
pub async fn bring_forward(ui: &Accessibility, app_id: &str, title: &str) -> Result<()> {
    // Focus can take a moment to follow a keyboard that just appeared.
    for _ in 0..5 {
        if ui.window_active().await? {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(60)).await;
    }
    if activate(app_id).await {
        for _ in 0..12 {
            tokio::time::sleep(Duration::from_millis(60)).await;
            if ui.window_active().await? {
                return Ok(());
            }
        }
    }
    let name = if title.is_empty() { "The shared window" } else { title };
    Err(Fault::new(
        "focus_changed",
        format!(
            "{name} is behind another window on that computer, so a click would reach the window in front. Bring it to the front there, or share the screen to use the whole desktop."
        ),
    )
    .phase("rejected-before-dispatch"))
}

#[cfg(test)]
mod tests {
    use super::application_path;

    #[test]
    fn an_application_id_becomes_the_object_path_its_app_exports() {
        assert_eq!(application_path("org.gnome.Calculator"), "/org/gnome/Calculator");
        assert_eq!(application_path("dev.ace.Live-View"), "/dev/ace/Live_View");
        assert_eq!(application_path("org.example.2048"), "/org/example/_2048");
    }
}
