//! X11 control uses EWMH identity. Capture connects once per active session.
use crate::{
    accessibility::Bounds,
    policy::point,
    protocol::{Fault, Result, Target, internal},
};
use serde_json::{Value, json};
use x11rb::protocol::damage::ConnectionExt as _;
use x11rb::protocol::shm::ConnectionExt as _;
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::{connection::Connection, protocol::xproto::*, rust_connection::RustConnection};

pub struct X11 {
    pub conn: RustConnection,
    pub root: u32,
}
#[derive(Clone)]
pub struct Window {
    pub id: u32,
    pub pid: u32,
    pub identity: String,
    pub bounds: Bounds,
}
impl X11 {
    pub fn connect() -> Result<Self> {
        let (conn, index) = x11rb::connect(None)
            .map_err(|e| Fault::new("not_supported", format!("Cannot open X11 display: {e}")))?;
        let root = conn.setup().roots[index].root;
        conn.shm_query_version()
            .map_err(internal)?
            .reply()
            .map_err(|e| Fault::new("not_supported", format!("XShm unavailable: {e}")))?;
        conn.damage_query_version(1, 1)
            .map_err(internal)?
            .reply()
            .map_err(internal)?;
        conn.xtest_get_version(2, 2)
            .map_err(internal)?
            .reply()
            .map_err(internal)?;
        Ok(Self { conn, root })
    }
    fn atom(&self, name: &str) -> Result<u32> {
        Ok(self
            .conn
            .intern_atom(false, name.as_bytes())
            .map_err(internal)?
            .reply()
            .map_err(internal)?
            .atom)
    }
    fn property(
        &self,
        window: u32,
        name: &str,
        kind: AtomEnum,
        limit: u32,
    ) -> Result<GetPropertyReply> {
        self.conn
            .get_property(false, window, self.atom(name)?, kind, 0, limit)
            .map_err(internal)?
            .reply()
            .map_err(|e| Fault::new("target_gone", e.to_string()))
    }
    pub fn windows(&self) -> Result<Vec<Window>> {
        let list = self.property(self.root, "_NET_CLIENT_LIST", AtomEnum::WINDOW, 2048)?;
        let mut windows = Vec::new();
        if let Some(ids) = list.value32() {
            for id in ids.take(2048) {
                if let Ok(w) = self.window(id) {
                    windows.push(w);
                }
            }
        }
        Ok(windows)
    }
    pub fn window(&self, id: u32) -> Result<Window> {
        let pid = self
            .property(id, "_NET_WM_PID", AtomEnum::CARDINAL, 1)?
            .value32()
            .and_then(|mut i| i.next())
            .ok_or_else(|| Fault::new("not_supported", "Window has no EWMH process id"))?;
        let class = self.property(id, "WM_CLASS", AtomEnum::STRING, 256)?.value;
        let identity = String::from_utf8_lossy(&class)
            .split('\0')
            .filter(|s| !s.is_empty())
            .next_back()
            .unwrap_or("")
            .to_owned();
        if identity.is_empty() {
            return Err(Fault::new(
                "not_supported",
                "Window has no WM_CLASS identity",
            ));
        }
        let g = self
            .conn
            .get_geometry(id)
            .map_err(internal)?
            .reply()
            .map_err(|e| Fault::new("target_gone", e.to_string()))?;
        let t = self
            .conn
            .translate_coordinates(id, self.root, 0, 0)
            .map_err(internal)?
            .reply()
            .map_err(internal)?;
        Ok(Window {
            id,
            pid,
            identity,
            bounds: Bounds {
                x: t.dst_x.into(),
                y: t.dst_y.into(),
                w: g.width.into(),
                h: g.height.into(),
            },
        })
    }
    pub fn inventory(&self) -> Result<Value> {
        let geometry = self
            .conn
            .get_geometry(self.root)
            .map_err(internal)?
            .reply()
            .map_err(internal)?;
        let windows = self.windows()?.into_iter().map(|w| {
            let title = self.property(w.id,"_NET_WM_NAME",AtomEnum::ANY,256).ok().map(|p| String::from_utf8_lossy(&p.value).into_owned()).unwrap_or_default();
            json!({"windowId":w.id,"bundleId":w.identity,"title":title,"bounds":{"x":w.bounds.x,"y":w.bounds.y,"width":w.bounds.w,"height":w.bounds.h}})
        }).collect::<Vec<_>>();
        Ok(
            json!({"displays":[{"displayId":self.root,"width":geometry.width,"height":geometry.height}],"windows":windows}),
        )
    }
    pub fn target(&self, target: &Target, allowlist: &[String]) -> Result<Window> {
        if target.kind == "display" {
            return Err(Fault::new(
                "not_supported",
                "Unfiltered X11 display capture cannot enforce per-application approval; select a window",
            ));
        }
        let identity = target
            .bundle_id
            .as_ref()
            .ok_or_else(|| Fault::new("bounds", "Missing application identity"))?;
        if !allowlist.contains(identity) {
            return Err(Fault::new(
                "permission_denied",
                "Application approval required",
            ));
        }
        let window = match target.kind.as_str() {
            "window" => self.window(
                target
                    .window_id
                    .ok_or_else(|| Fault::new("bounds", "Missing window id"))?,
            )?,
            "app" => {
                let mut matches = self
                    .windows()?
                    .into_iter()
                    .filter(|w| &w.identity == identity);
                let w = matches
                    .next()
                    .ok_or_else(|| Fault::new("target_gone", "Application is not running"))?;
                if matches.next().is_some() {
                    return Err(Fault::new(
                        "bounds",
                        "Application has multiple windows; choose one",
                    ));
                }
                w
            }
            _ => return Err(Fault::new("not_supported", "Unknown target kind")),
        };
        if &window.identity != identity {
            return Err(Fault::new(
                "permission_denied",
                "Window identity differs from approved application",
            ));
        }
        Ok(window)
    }
    pub fn check(&self, w: &Window) -> Result<Window> {
        let live = self.window(w.id)?;
        if live.pid != w.pid || live.identity != w.identity {
            return Err(Fault::new("target_gone", "Window was replaced"));
        }
        let active = self
            .property(self.root, "_NET_ACTIVE_WINDOW", AtomEnum::WINDOW, 1)?
            .value32()
            .and_then(|mut i| i.next());
        if active != Some(w.id) {
            return Err(Fault::new(
                "busy",
                "Target window is not active; focus it before input",
            ));
        }
        Ok(live)
    }
    pub fn focus(&self, w: &Window) -> Result<()> {
        let event =
            ClientMessageEvent::new(32, w.id, self.atom("_NET_ACTIVE_WINDOW")?, [2, 0, 0, 0, 0]);
        self.conn
            .send_event(
                false,
                self.root,
                EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
                event,
            )
            .map_err(internal)?
            .check()
            .map_err(internal)?;
        self.conn.flush().map_err(internal)
    }
    fn fake(&self, kind: u8, detail: u8, x: i16, y: i16) -> Result<()> {
        self.conn
            .xtest_fake_input(kind, detail, 0, self.root, x, y, 0)
            .map_err(internal)?
            .check()
            .map_err(internal)?;
        self.conn.flush().map_err(internal)
    }
    pub fn motion(&self, w: &Window, x: f64, y: f64) -> Result<()> {
        let live = self.check(w)?;
        let (x, y) = point(x, y, live.bounds.w as u32, live.bounds.h as u32)?;
        let x = i16::try_from(live.bounds.x + x.round() as i32).map_err(internal)?;
        let y = i16::try_from(live.bounds.y + y.round() as i32).map_err(internal)?;
        self.fake(MOTION_NOTIFY_EVENT, 0, x, y)
    }
    pub fn click(&self, w: &Window, x: f64, y: f64, button: &str) -> Result<()> {
        let b = match button {
            "left" => 1,
            "middle" => 2,
            "right" => 3,
            _ => return Err(Fault::new("bounds", "Unknown button")),
        };
        self.motion(w, x, y)?;
        self.fake(BUTTON_PRESS_EVENT, b, 0, 0)?;
        self.fake(BUTTON_RELEASE_EVENT, b, 0, 0)
    }
    pub fn drag(&self, w: &Window, x: f64, y: f64, to_x: f64, to_y: f64) -> Result<()> {
        let live = self.check(w)?;
        point(to_x, to_y, live.bounds.w as u32, live.bounds.h as u32)?;
        self.motion(w, x, y)?;
        self.fake(BUTTON_PRESS_EVENT, 1, 0, 0)?;
        let moved = self.motion(w, to_x, to_y);
        let released = self.fake(BUTTON_RELEASE_EVENT, 1, 0, 0);
        moved.and(released)
    }
    fn keycode(&self, symbol: u32) -> Result<u8> {
        let setup = self.conn.setup();
        let mapping = self
            .conn
            .get_keyboard_mapping(setup.min_keycode, setup.max_keycode - setup.min_keycode + 1)
            .map_err(internal)?
            .reply()
            .map_err(internal)?;
        for (index, keys) in mapping
            .keysyms
            .chunks(mapping.keysyms_per_keycode as usize)
            .enumerate()
        {
            if keys.first() == Some(&symbol) {
                return Ok(setup.min_keycode + index as u8);
            }
        }
        Err(Fault::new(
            "not_supported",
            "Key is not in the X11 keyboard map",
        ))
    }
    pub fn key(&self, w: &Window, key: &str, modifiers: &[String]) -> Result<()> {
        self.check(w)?;
        if modifiers.len() > 4 {
            return Err(Fault::new("bounds", "Modifier limit"));
        }
        let symbol = keysym(key)?;
        let code = self.keycode(symbol)?;
        let mut codes = Vec::new();
        for m in modifiers {
            codes.push(self.keycode(match m.as_str() {
                "shift" => 0xffe1,
                "control" => 0xffe3,
                "alt" | "option" => 0xffe9,
                "super" | "command" => 0xffeb,
                _ => return Err(Fault::new("bounds", "Unknown modifier")),
            })?);
        }
        let mut sent = Ok(());
        for c in &codes {
            if let Err(error) = self.fake(KEY_PRESS_EVENT, *c, 0, 0) {
                sent = Err(error);
                break;
            }
        }
        if sent.is_ok() {
            sent = self.fake(KEY_PRESS_EVENT, code, 0, 0);
            let released = self.fake(KEY_RELEASE_EVENT, code, 0, 0);
            sent = sent.and(released);
        }
        // Attempt every release even if an earlier release or key press failed.
        for c in codes.iter().rev() {
            let released = self.fake(KEY_RELEASE_EVENT, *c, 0, 0);
            sent = sent.and(released);
        }
        sent
    }
    pub fn scroll(&self, w: &Window, dx: f64, dy: f64) -> Result<()> {
        self.check(w)?;
        if !dx.is_finite() || !dy.is_finite() || dx.abs() > 1000. || dy.abs() > 1000. {
            return Err(Fault::new("bounds", "Scroll exceeds limit"));
        }
        for (delta, negative, positive) in [(dy, 4, 5), (dx, 6, 7)] {
            for _ in 0..delta.abs().ceil() as u32 {
                let b = if delta < 0. { negative } else { positive };
                self.fake(BUTTON_PRESS_EVENT, b, 0, 0)?;
                self.fake(BUTTON_RELEASE_EVENT, b, 0, 0)?;
            }
        }
        Ok(())
    }
}
pub fn keysym(key: &str) -> Result<u32> {
    let symbol = match key {
        "Enter" => 0xff0d,
        "Tab" => 0xff09,
        "Escape" => 0xff1b,
        "Backspace" => 0xff08,
        "Delete" => 0xffff,
        "Left" | "ArrowLeft" => 0xff51,
        "Up" | "ArrowUp" => 0xff52,
        "Right" | "ArrowRight" => 0xff53,
        "Down" | "ArrowDown" => 0xff54,
        "Home" => 0xff50,
        "End" => 0xff57,
        "Space" => 32,
        _ if key.chars().count() == 1 => key.chars().next().map(u32::from).unwrap_or(0),
        _ => return Err(Fault::new("not_supported", "Unknown key name")),
    };
    Ok(if symbol > 255 && symbol < 0xff00 {
        0x01000000 | symbol
    } else {
        symbol
    })
}
