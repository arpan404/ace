use crate::{
    protocol::{Fault, Request, Result, internal},
    runtime::Runtime,
    x11::keysym,
};
use serde_json::{Value, json};
impl Runtime {
    pub(crate) async fn click(&self, x: f64, y: f64, button: &str) -> Result<()> {
        if let (Some(backend), Some(w)) = (&self.x, &self.window) {
            backend.click(w, x, y, button)
        } else {
            let p = self.portal.as_ref().ok_or_else(|| internal("No portal"))?;
            p.motion(x, y).await?;
            p.button(button, true).await?;
            p.button(button, false).await
        }
    }
    pub(crate) async fn key(&self, key: &str, modifiers: &[String]) -> Result<()> {
        if let (Some(x), Some(w)) = (&self.x, &self.window) {
            return x.key(w, key, modifiers);
        }
        if modifiers.len() > 4 {
            return Err(Fault::new("bounds", "Modifier limit"));
        }
        let p = self.portal.as_ref().ok_or_else(|| internal("No portal"))?;
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
    pub(crate) async fn input(&mut self, r: &Request) -> Result<Value> {
        self.check_input()?;
        match r.op.as_str() {
            "pointer.move" => {
                let (px, py) = coordinates(r)?;
                if let (Some(x), Some(w)) = (&self.x, &self.window) {
                    x.motion(w, px, py)?;
                } else {
                    self.portal
                        .as_ref()
                        .ok_or_else(|| internal("No portal"))?
                        .motion(px, py)
                        .await?;
                }
            }
            "pointer.click" => {
                let (x, y) = coordinates(r)?;
                self.click(x, y, r.button.as_deref().unwrap_or("left"))
                    .await?;
            }
            "pointer.drag" => {
                let (px, py) = coordinates(r)?;
                let (tx, ty) = (
                    r.to_x.ok_or_else(|| Fault::new("bounds", "Missing toX"))?,
                    r.to_y.ok_or_else(|| Fault::new("bounds", "Missing toY"))?,
                );
                if let (Some(x), Some(w)) = (&self.x, &self.window) {
                    x.drag(w, px, py, tx, ty)?;
                } else {
                    let p = self.portal.as_ref().ok_or_else(|| internal("No portal"))?;
                    crate::policy::point(tx, ty, p.size.0, p.size.1)?;
                    p.motion(px, py).await?;
                    p.button("left", true).await?;
                    let moved = p.motion(tx, ty).await;
                    let released = p.button("left", false).await;
                    moved.and(released)?;
                }
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
                self.check_ui()?;
                let text = r
                    .text
                    .as_deref()
                    .ok_or_else(|| Fault::new("bounds", "Missing text"))?;
                if text.len() > 4096 {
                    return Err(Fault::new("bounds", "Text exceeds limit"));
                }
                self.ui
                    .as_mut()
                    .ok_or_else(|| Fault::new("not_supported", "AT-SPI unavailable"))?
                    .type_text(text)
                    .await?;
            }
            "scroll" => {
                let dx = r.dx.unwrap_or(0.);
                let dy = r.dy.unwrap_or(0.);
                if let (Some(x), Some(w)) = (&self.x, &self.window) {
                    x.scroll(w, dx, dy)?;
                } else {
                    self.portal
                        .as_ref()
                        .ok_or_else(|| internal("No portal"))?
                        .scroll(dx, dy)
                        .await?;
                }
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

fn coordinates(r: &Request) -> Result<(f64, f64)> {
    Ok((
        r.x.ok_or_else(|| Fault::new("bounds", "Missing x"))?,
        r.y.ok_or_else(|| Fault::new("bounds", "Missing y"))?,
    ))
}
