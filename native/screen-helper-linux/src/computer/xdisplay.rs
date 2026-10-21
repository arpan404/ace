//! X11 for the computer engine: finding an app's windows, EWMH window operations and XTest
//! input primitives. Only used in an X11 session; Wayland has none of this.
use crate::computer::error::{CuError, CuResult};
use std::cell::RefCell;
use std::collections::HashMap;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::*;
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

#[derive(Clone, Debug)]
pub struct XWindow {
    pub id: u32,
    pub pid: Option<u32>,
    pub title: String,
    pub wm_class: Vec<String>,
    pub gtk_application_id: Option<String>,
}

pub struct XDisplay {
    pub conn: RustConnection,
    pub root: u32,
    atoms: RefCell<HashMap<&'static str, u32>>,
    /// Keycodes borrowed for characters missing from the keymap, to put back.
    pub borrowed: RefCell<Vec<(u8, Vec<u32>)>>,
}

fn x_error(e: impl std::fmt::Display) -> CuError {
    CuError::new("internal", format!("X11 request failed: {e}"))
}

/// Whether this session is X11. A Wayland session's XWayland display is not used.
pub fn is_x11_session(env: &dyn Fn(&str) -> Option<String>) -> bool {
    let set = |name: &str| env(name).is_some_and(|v| !v.is_empty());
    let wayland = set("WAYLAND_DISPLAY") || env("XDG_SESSION_TYPE").as_deref() == Some("wayland");
    set("DISPLAY") && !wayland
}

impl XDisplay {
    pub fn connect() -> Option<Self> {
        if !is_x11_session(&|name| std::env::var(name).ok()) {
            return None;
        }
        let (conn, screen) = x11rb::connect(None).ok()?;
        let root = conn.setup().roots.get(screen)?.root;
        Some(Self {
            conn,
            root,
            atoms: RefCell::new(HashMap::new()),
            borrowed: RefCell::new(Vec::new()),
        })
    }

    pub fn atom(&self, name: &'static str) -> CuResult<u32> {
        if let Some(atom) = self.atoms.borrow().get(name) {
            return Ok(*atom);
        }
        let atom = self
            .conn
            .intern_atom(false, name.as_bytes())
            .map_err(x_error)?
            .reply()
            .map_err(x_error)?
            .atom;
        self.atoms.borrow_mut().insert(name, atom);
        Ok(atom)
    }

    fn property(&self, window: u32, name: &'static str, kind: AtomEnum, length: u32) -> Option<GetPropertyReply> {
        let atom = self.atom(name).ok()?;
        self.conn
            .get_property(false, window, atom, kind, 0, length)
            .ok()?
            .reply()
            .ok()
    }

    fn text_property(&self, window: u32, name: &'static str) -> Option<String> {
        let reply = self.property(window, name, AtomEnum::ANY, 1024)?;
        (!reply.value.is_empty()).then(|| String::from_utf8_lossy(&reply.value).into_owned())
    }

    fn cardinal(&self, window: u32, name: &'static str) -> Option<u32> {
        self.property(window, name, AtomEnum::ANY, 1)?.value32()?.next()
    }

    pub fn describe(&self, id: u32) -> XWindow {
        let class = self
            .property(id, "WM_CLASS", AtomEnum::STRING, 256)
            .map(|p| p.value)
            .unwrap_or_default();
        XWindow {
            id,
            pid: self.cardinal(id, "_NET_WM_PID"),
            title: self
                .text_property(id, "_NET_WM_NAME")
                .or_else(|| self.text_property(id, "WM_NAME"))
                .unwrap_or_default(),
            wm_class: String::from_utf8_lossy(&class)
                .split('\0')
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
            gtk_application_id: self.text_property(id, "_GTK_APPLICATION_ID"),
        }
    }

    /// Top-level client windows the window manager manages.
    pub fn client_windows(&self) -> Vec<XWindow> {
        let Some(list) = self.property(self.root, "_NET_CLIENT_LIST", AtomEnum::WINDOW, 4096) else {
            return Vec::new();
        };
        list.value32()
            .map(|ids| ids.map(|id| self.describe(id)).collect())
            .unwrap_or_default()
    }

    pub fn active_window(&self) -> Option<u32> {
        self.cardinal(self.root, "_NET_ACTIVE_WINDOW").filter(|id| *id != 0)
    }

    /// The window of `pid` titled like the accessible window, else its largest one.
    pub fn window_for(&self, pid: u32, title: &str) -> Option<u32> {
        let windows: Vec<XWindow> = self
            .client_windows()
            .into_iter()
            .filter(|w| w.pid == Some(pid))
            .collect();
        if let Some(window) = windows.iter().find(|w| !title.is_empty() && w.title == title) {
            return Some(window.id);
        }
        windows
            .iter()
            .filter_map(|w| self.geometry(w.id).map(|g| (w.id, u64::from(g.2) * u64::from(g.3))))
            .max_by_key(|(_, area)| *area)
            .map(|(id, _)| id)
    }

    /// Absolute position and size.
    pub fn geometry(&self, window: u32) -> Option<(i32, i32, u32, u32)> {
        let geometry = self.conn.get_geometry(window).ok()?.reply().ok()?;
        let origin = self
            .conn
            .translate_coordinates(window, self.root, 0, 0)
            .ok()?
            .reply()
            .ok()?;
        Some((
            origin.dst_x.into(),
            origin.dst_y.into(),
            geometry.width.into(),
            geometry.height.into(),
        ))
    }

    pub fn is_viewable(&self, window: u32) -> bool {
        self.conn
            .get_window_attributes(window)
            .ok()
            .and_then(|c| c.reply().ok())
            .is_some_and(|a| a.map_state == MapState::VIEWABLE)
    }

    pub fn has_state(&self, window: u32, state: &'static str) -> bool {
        let Ok(wanted) = self.atom(state) else { return false };
        self.property(window, "_NET_WM_STATE", AtomEnum::ATOM, 64)
            .and_then(|p| p.value32().map(|mut atoms| atoms.any(|a| a == wanted)))
            .unwrap_or(false)
    }

    fn client_message(&self, window: u32, kind: &'static str, data: [u32; 5]) -> CuResult<()> {
        let event = ClientMessageEvent::new(32, window, self.atom(kind)?, data);
        self.conn
            .send_event(
                false,
                self.root,
                EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
                event,
            )
            .map_err(x_error)?;
        self.conn.flush().map_err(x_error)
    }

    pub fn activate(&self, window: u32) -> CuResult<()> {
        self.client_message(window, "_NET_ACTIVE_WINDOW", [2, x11rb::CURRENT_TIME, 0, 0, 0])
    }

    pub fn close(&self, window: u32) -> CuResult<()> {
        self.client_message(window, "_NET_CLOSE_WINDOW", [x11rb::CURRENT_TIME, 2, 0, 0, 0])
    }

    pub fn minimize(&self, window: u32) -> CuResult<()> {
        self.client_message(window, "WM_CHANGE_STATE", [3, 0, 0, 0, 0])
    }

    /// Adds (1) or removes (0) up to two `_NET_WM_STATE` atoms.
    pub fn set_state(&self, window: u32, add: bool, first: &'static str, second: Option<&'static str>) -> CuResult<()> {
        let second = second.map(|s| self.atom(s)).transpose()?.unwrap_or(0);
        self.client_message(
            window,
            "_NET_WM_STATE",
            [u32::from(add), self.atom(first)?, second, 2, 0],
        )
    }

    pub fn map(&self, window: u32) -> CuResult<()> {
        self.conn.map_window(window).map_err(x_error)?;
        self.conn.flush().map_err(x_error)
    }

    pub fn raise(&self, window: u32) -> CuResult<()> {
        self.client_message(window, "_NET_RESTACK_WINDOW", [2, 0, 0, 0, 0])?;
        self.conn
            .configure_window(window, &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE))
            .map_err(x_error)?;
        self.conn.flush().map_err(x_error)
    }

    /// `_NET_MOVERESIZE_WINDOW` with only the given fields.
    pub fn move_resize(&self, window: u32, position: Option<(i32, i32)>, size: Option<(u32, u32)>) -> CuResult<()> {
        let mut flags = 10u32 | (2 << 12);
        let (x, y) = position.unwrap_or((0, 0));
        let (w, h) = size.unwrap_or((0, 0));
        if position.is_some() {
            flags |= (1 << 8) | (1 << 9);
        }
        if size.is_some() {
            flags |= (1 << 10) | (1 << 11);
        }
        self.client_message(window, "_NET_MOVERESIZE_WINDOW", [flags, x as u32, y as u32, w, h])
    }

    // Input primitives. Callers check the target window is active first.

    fn fake(&self, kind: u8, detail: u8, x: i16, y: i16) -> CuResult<()> {
        self.conn
            .xtest_fake_input(kind, detail, x11rb::CURRENT_TIME, self.root, x, y, 0)
            .map_err(x_error)?;
        Ok(())
    }

    pub fn flush(&self) -> CuResult<()> {
        self.conn.sync().map_err(x_error)
    }

    pub fn key(&self, code: u8, down: bool) -> CuResult<()> {
        self.fake(if down { KEY_PRESS_EVENT } else { KEY_RELEASE_EVENT }, code, 0, 0)
    }

    pub fn button(&self, button: u8, down: bool) -> CuResult<()> {
        self.fake(
            if down { BUTTON_PRESS_EVENT } else { BUTTON_RELEASE_EVENT },
            button,
            0,
            0,
        )
    }

    pub fn motion(&self, x: i32, y: i32) -> CuResult<()> {
        let clamp = |v: i32| v.clamp(i32::from(i16::MIN), i32::from(i16::MAX)) as i16;
        self.fake(MOTION_NOTIFY_EVENT, 0, clamp(x), clamp(y))
    }

    /// The keycode for a keysym and whether Shift is needed. A keysym missing from the map is
    /// bound to a spare keycode, given back by `restore_keymap`.
    pub fn keycode(&self, keysym: u32) -> CuResult<(u8, bool)> {
        let setup = self.conn.setup();
        let (min, max) = (setup.min_keycode, setup.max_keycode);
        let mapping = self
            .conn
            .get_keyboard_mapping(min, max - min + 1)
            .map_err(x_error)?
            .reply()
            .map_err(x_error)?;
        let per = usize::from(mapping.keysyms_per_keycode.max(1));
        let mut spare = None;
        for (index, symbols) in mapping.keysyms.chunks(per).enumerate() {
            let code = min + index as u8;
            if symbols.first() == Some(&keysym) {
                return Ok((code, false));
            }
            if symbols.get(1) == Some(&keysym) {
                return Ok((code, true));
            }
            if spare.is_none() && symbols.iter().all(|s| *s == 0) {
                spare = Some(code);
            }
        }
        let code = spare.ok_or_else(|| {
            CuError::new(
                "bad_key",
                "The keyboard map has no free key to type this character. Use type with an element id instead.",
            )
        })?;
        let mut symbols = vec![0u32; per];
        symbols[0] = keysym;
        if per > 1 {
            symbols[1] = keysym;
        }
        self.conn
            .change_keyboard_mapping(1, code, per as u8, &symbols)
            .map_err(x_error)?;
        self.conn.sync().map_err(x_error)?;
        self.borrowed.borrow_mut().push((code, vec![0; per]));
        Ok((code, false))
    }

    pub fn restore_keymap(&self) {
        for (code, symbols) in self.borrowed.borrow_mut().drain(..) {
            let _ = self
                .conn
                .change_keyboard_mapping(1, code, symbols.len() as u8, &symbols);
        }
        let _ = self.conn.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::is_x11_session;

    #[test]
    fn a_wayland_session_never_uses_its_xwayland_display() {
        let x11 = |name: &str| (name == "DISPLAY").then(|| ":0".to_owned());
        assert!(is_x11_session(&x11));
        let wayland = |name: &str| match name {
            "DISPLAY" => Some(":0".to_owned()),
            "WAYLAND_DISPLAY" => Some("wayland-0".to_owned()),
            _ => None,
        };
        assert!(!is_x11_session(&wayland));
        assert!(!is_x11_session(&|_| None));
    }
}
