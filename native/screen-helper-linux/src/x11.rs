//! X11 control uses EWMH identity. Capture connects once per active session.
use crate::{
    accessibility::Bounds,
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
    /// The computer engine's view of the display, which names windows' apps.
    apps: Option<crate::computer::xdisplay::XDisplay>,
}
#[derive(Clone)]
pub struct Window {
    pub id: u32,
    pub pid: u32,
    /// The app's desktop-file id (`org.gnome.Calculator`), as computer use names it.
    pub identity: String,
    /// The window's own WM_CLASS class, which must not change while it is shared.
    pub class: String,
    pub bounds: Bounds,
}
impl Window {
    /// Whether `live` is still this window: same id, process and class.
    pub fn same_as(&self, live: &Window) -> bool {
        live.id == self.id && live.pid == self.pid && live.class == self.class
    }
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
        Ok(Self {
            conn,
            root,
            apps: crate::computer::xdisplay::XDisplay::connect(),
        })
    }
    /// Names a window's app the way computer use does; its WM_CLASS when that finds nothing.
    pub fn named(&self, mut window: Window, installed: &[crate::computer::desktop::DesktopApp]) -> Window {
        if let Some(x) = &self.apps {
            let id = crate::computer::apps::x_window_app_id(x, window.id, window.pid, installed);
            if !id.is_empty() {
                window.identity = id;
            }
        }
        window
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
        let class = String::from_utf8_lossy(&class)
            .split('\0')
            .filter(|s| !s.is_empty())
            .next_back()
            .unwrap_or("")
            .to_owned();
        if class.is_empty() {
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
            identity: class.clone(),
            class,
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
        let installed = crate::computer::apps::installed();
        let windows = self.windows()?.into_iter().map(|w| self.named(w, &installed)).map(|w| {
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
        let installed = crate::computer::apps::installed();
        let window = match target.kind.as_str() {
            "window" => self.named(
                self.window(
                    target
                        .window_id
                        .ok_or_else(|| Fault::new("bounds", "Missing window id"))?,
                )?,
                &installed,
            ),
            "app" => {
                let mut matches = self
                    .windows()?
                    .into_iter()
                    .map(|w| self.named(w, &installed))
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
        if !w.same_as(&live) {
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
    pub(crate) fn fake(&self, kind: u8, detail: u8, x: i16, y: i16) -> Result<()> {
        self.conn
            .xtest_fake_input(kind, detail, 0, self.root, x, y, 0)
            .map_err(internal)?
            .check()
            .map_err(internal)?;
        self.conn.flush().map_err(internal)
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
    /// Types text key by key into the shared window while it is active, for apps whose text
    /// fields accessibility can't reach. Characters missing from the keyboard map borrow a
    /// spare key, given back afterwards.
    pub fn type_text(&self, w: &Window, text: &str) -> Result<()> {
        self.check(w)?;
        let x = self
            .apps
            .as_ref()
            .ok_or_else(|| Fault::new("not_supported", "Typing needs the X keyboard map"))?;
        let failed = |e: crate::computer::error::CuError| Fault::new("not_supported", e.to_string());
        let typed = (|| {
            let (shift, _) = x.keycode(0xffe1).map_err(failed)?;
            for c in text.chars() {
                let (code, shifted) = x
                    .keycode(crate::runtime_input::unicode_keysym(c))
                    .map_err(failed)?;
                if shifted {
                    x.key(shift, true).map_err(failed)?;
                }
                let pressed = x.key(code, true).and(x.key(code, false)).map_err(failed);
                if shifted {
                    x.key(shift, false).map_err(failed)?;
                }
                pressed?;
            }
            x.flush().map_err(failed)
        })();
        x.restore_keymap();
        typed
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
                "meta" | "super" | "command" => 0xffeb,
                _ => {
                    return Err(Fault::new("modifier_unsupported", "Unsupported modifier")
                        .phase("rejected-before-dispatch"));
                }
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
}
pub fn keysym(key: &str) -> Result<u32> {
    let symbol = match key.to_ascii_lowercase().as_str() {
        "enter" | "return" => 0xff0d,
        "tab" => 0xff09,
        "escape" | "esc" => 0xff1b,
        "backspace" => 0xff08,
        "delete" => 0xffff,
        "left" | "arrowleft" => 0xff51,
        "up" | "arrowup" => 0xff52,
        "right" | "arrowright" => 0xff53,
        "down" | "arrowdown" => 0xff54,
        "home" => 0xff50,
        "end" => 0xff57,
        "space" => 32,
        "pageup" => 0xff55,
        "pagedown" => 0xff56,
        name if name
            .strip_prefix('f')
            .and_then(|n| n.parse::<u32>().ok())
            .is_some_and(|n| (1..=20).contains(&n)) =>
        {
            0xffbd + name[1..].parse::<u32>().unwrap_or(0)
        }
        _ if key.chars().count() == 1 => key.chars().next().map(u32::from).unwrap_or(0),
        _ => {
            return Err(
                Fault::new("key_unsupported", "Unsupported key").phase("rejected-before-dispatch")
            );
        }
    };
    Ok(if symbol > 255 && symbol < 0xff00 {
        0x01000000 | symbol
    } else {
        symbol
    })
}
