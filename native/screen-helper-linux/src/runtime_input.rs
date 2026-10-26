use crate::{
    keysym::keysym,
    protocol::{Fault, Request, Result, internal},
    runtime::Runtime,
};
use serde_json::{Value, json};
impl Runtime {
    pub(crate) async fn click(&self, x: f64, y: f64, button: &str) -> Result<()> {
        let p = &self.portal;
        p.motion(x, y).await?;
        p.button(button, true).await?;
        p.button(button, false).await
    }
    pub(crate) async fn key(&self, key: &str, modifiers: &[String]) -> Result<()> {
        if modifiers.len() > 4 {
            return Err(Fault::new("bounds", "Modifier limit"));
        }
        let p = &self.portal;
        let symbol = keysym(key)?;
        let mut held = Vec::new();
        for m in modifiers {
            held.push(match m.as_str() {
                "shift" => 0xffe1,
                "control" => 0xffe3,
                "alt" | "option" => 0xffe9,
                "super" | "command" => 0xffeb,
                _ => return Err(Fault::new("bounds", "Unknown modifier")),
            });
        }
        let mut sent = Ok(());
        for s in &held {
            if let Err(error) = p.key_symbol(*s, true).await {
                sent = Err(error);
                break;
            }
        }
        if sent.is_ok() {
            sent = p.key_symbol(symbol, true).await;
            let released = p.key_symbol(symbol, false).await;
            sent = sent.and(released);
        }
        for s in held.into_iter().rev() {
            let released = p.key_symbol(s, false).await;
            sent = sent.and(released);
        }
        sent
    }
    /// A person's input to a shared Wayland window waits until that window is in front.
    async fn front_for_person(&self, r: &Request) -> Result<()> {
        let p = &self.portal;
        let (Some(ui), true, false, true) = (&self.ui, r.person, self.view_only, self.ui_active)
        else {
            return Ok(());
        };
        let Some(app) = p.picked.as_ref().and_then(|picked| picked.app.as_ref()) else {
            return Ok(());
        };
        p.wake().await?;
        crate::portal_front::bring_forward(ui, &app.app_id, &app.title).await
    }
    pub(crate) async fn input(&mut self, r: &Request) -> Result<Value> {
        self.check_input(r.person)?;
        self.front_for_person(r).await?;
        match r.op.as_str() {
            "pointer.move" => {
                let (px, py) = coordinates(r)?;
                self.portal.motion(px, py).await?;
            }
            "pointer.click" => {
                let (x, y) = coordinates(r)?;
                self.click(x, y, r.button.as_deref().unwrap_or("left")).await?;
            }
            "pointer.drag" => {
                let (px, py) = coordinates(r)?;
                let (tx, ty) = (
                    r.to_x.ok_or_else(|| Fault::new("bounds", "Missing toX"))?,
                    r.to_y.ok_or_else(|| Fault::new("bounds", "Missing toY"))?,
                );
                let duration = std::time::Duration::from_millis(r.duration_ms.unwrap_or(300).clamp(1, 10_000));
                let p = &self.portal;
                p.motion(px, py).await?;
                p.button("left", true).await?;
                let mut moved = Ok(());
                for step in 1..=12u32 {
                    tokio::time::sleep(duration / 12).await;
                    let t = f64::from(step) / 12.;
                    moved = p.motion(px + (tx - px) * t, py + (ty - py) * t).await;
                    if moved.is_err() {
                        break;
                    }
                }
                let released = p.button("left", false).await;
                moved.and(released)?;
            }
            "key.press" => {
                self.key(
                    r.key
                        .as_deref()
                        .ok_or_else(|| Fault::new("bounds", "Missing key"))?,
                    &r.modifiers,
                )
                .await?
            }
            "text.type" => {
                let text = r
                    .text
                    .as_deref()
                    .ok_or_else(|| Fault::new("bounds", "Missing text"))?;
                if text.len() > 4096 {
                    return Err(Fault::new("bounds", "Text exceeds limit"));
                }
                // The person's typing, or typing without the app's accessibility, goes through the
                // portal's keyboard key by key, wherever the window's focus is.
                if r.person || !self.ui_active {
                    let p = &self.portal;
                    for c in text.chars() {
                        let symbol = unicode_keysym(c);
                        p.key_symbol(symbol, true).await?;
                        p.key_symbol(symbol, false).await?;
                    }
                    return Ok(json!({}));
                }
                self.check_ui()?;
                self.ui
                    .as_mut()
                    .ok_or_else(|| Fault::new("not_supported", "AT-SPI unavailable"))?
                    .type_text(text)
                    .await?;
            }
            "scroll" => {
                let dx = r.dx.unwrap_or(0.);
                let dy = r.dy.unwrap_or(0.);
                let at = r.x.zip(r.y);
                self.portal.scroll(at, dx, dy).await?;
            }
            _ => return Err(Fault::new("not_supported", "Unknown input")),
        }
        Ok(json!({}))
    }
    pub(crate) async fn legacy(&mut self, r: &Request) -> Result<Value> {
        let a = r
            .action
            .as_ref()
            .ok_or_else(|| Fault::new("bounds", "Missing action"))?;
        let mut data = json!({"version":2,"id":r.id});
        match a["kind"].as_str() {
            Some("click") => {
                data["op"] = json!("pointer.click");
                data["x"] = a["x"].clone();
                data["y"] = a["y"].clone();
                data["button"] = a["button"].clone();
            }
            Some("type") => {
                data["op"] = json!("text.type");
                data["text"] = a["text"].clone();
            }
            Some("scroll") => {
                data["op"] = json!("scroll");
                data["dx"] = a["deltaX"].clone();
                data["dy"] = a["deltaY"].clone();
            }
            Some("key") => {
                return Err(Fault::new(
                    "not_supported",
                    "macOS virtual key codes are not portable; use key.press with a key name",
                ));
            }
            _ => return Err(Fault::new("not_supported", "Unknown legacy action")),
        }
        let parsed = Request::parse(&serde_json::to_vec(&data).map_err(internal)?)?;
        self.input(&parsed).await
    }
}

/// The keysym for a character: Latin-1 as itself, the rest as Unicode keysyms; line breaks
/// and tabs as the keys that type them.
pub(crate) fn unicode_keysym(c: char) -> u32 {
    match c {
        '\n' | '\r' => 0xff0d,
        '\t' => 0xff09,
        c if (c as u32) < 0x100 => c as u32,
        c => 0x0100_0000 | c as u32,
    }
}

fn coordinates(r: &Request) -> Result<(f64, f64)> {
    Ok((
        r.x.ok_or_else(|| Fault::new("bounds", "Missing x"))?,
        r.y.ok_or_else(|| Fault::new("bounds", "Missing y"))?,
    ))
}
