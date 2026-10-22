//! The X clipboard, borrowed for a paste: the old text is read first and served again after
//! the paste. X keeps no clipboard of its own, so text this helper serves lasts while it runs
//! (or until a clipboard manager takes it).
use crate::computer::error::{CuError, CuResult};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use x11rb::connection::Connection;
use x11rb::protocol::Event;
use x11rb::protocol::xproto::*;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

struct Atoms {
    clipboard: u32,
    utf8: u32,
    targets: u32,
    property: u32,
}

fn atoms(conn: &RustConnection) -> Option<Atoms> {
    let atom = |name: &str| {
        conn.intern_atom(false, name.as_bytes())
            .ok()?
            .reply()
            .ok()
            .map(|r| r.atom)
    };
    Some(Atoms {
        clipboard: atom("CLIPBOARD")?,
        utf8: atom("UTF8_STRING")?,
        targets: atom("TARGETS")?,
        property: atom("ACE_CLIPBOARD")?,
    })
}

fn unavailable() -> CuError {
    CuError::new(
        "paste_failed",
        "The X clipboard is not available. Use type, or set_value on the field.",
    )
}

/// Owns the clipboard from a thread of its own, serving whatever text it is given.
pub struct Clipboard {
    text: Arc<Mutex<Option<String>>>,
    claim: std::sync::mpsc::Sender<()>,
}

impl Clipboard {
    pub fn start() -> CuResult<Self> {
        let (conn, screen) = x11rb::connect(None).map_err(|_| unavailable())?;
        let root = conn.setup().roots.get(screen).ok_or_else(unavailable)?.root;
        let atoms = atoms(&conn).ok_or_else(unavailable)?;
        let window = conn.generate_id().map_err(|_| unavailable())?;
        conn.create_window(
            0,
            window,
            root,
            0,
            0,
            1,
            1,
            0,
            WindowClass::INPUT_ONLY,
            0,
            &CreateWindowAux::new(),
        )
        .map_err(|_| unavailable())?;
        conn.flush().map_err(|_| unavailable())?;
        let text = Arc::new(Mutex::new(None::<String>));
        let (claim, claims) = std::sync::mpsc::channel::<()>();
        let served = text.clone();
        std::thread::spawn(move || serve(conn, window, atoms, served, claims));
        Ok(Self { text, claim })
    }

    /// Serves `text` as the clipboard from now on.
    pub fn set(&self, text: String) {
        if let Ok(mut current) = self.text.lock() {
            *current = Some(text);
        }
        let _ = self.claim.send(());
        std::thread::sleep(Duration::from_millis(30));
    }
}

fn serve(
    conn: RustConnection,
    window: u32,
    atoms: Atoms,
    text: Arc<Mutex<Option<String>>>,
    claims: std::sync::mpsc::Receiver<()>,
) {
    loop {
        while claims.try_recv().is_ok() {
            let _ = conn.set_selection_owner(window, atoms.clipboard, x11rb::CURRENT_TIME);
            let _ = conn.flush();
        }
        let event = match conn.poll_for_event() {
            Ok(Some(event)) => event,
            Ok(None) => {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            }
            Err(_) => return,
        };
        let Event::SelectionRequest(request) = event else {
            continue;
        };
        let current = text.lock().ok().and_then(|t| t.clone());
        let property = if request.property == 0 {
            request.target
        } else {
            request.property
        };
        let mut answered = 0u32;
        if request.target == atoms.targets {
            let list = [atoms.targets, atoms.utf8, u32::from(AtomEnum::STRING)];
            if conn
                .change_property32(PropMode::REPLACE, request.requestor, property, AtomEnum::ATOM, &list)
                .is_ok()
            {
                answered = property;
            }
        } else if let Some(current) =
            current.filter(|_| request.target == atoms.utf8 || request.target == u32::from(AtomEnum::STRING))
        {
            if conn
                .change_property8(
                    PropMode::REPLACE,
                    request.requestor,
                    property,
                    request.target,
                    current.as_bytes(),
                )
                .is_ok()
            {
                answered = property;
            }
        }
        let notify = SelectionNotifyEvent {
            response_type: SELECTION_NOTIFY_EVENT,
            sequence: 0,
            time: request.time,
            requestor: request.requestor,
            selection: request.selection,
            target: request.target,
            property: answered,
        };
        let _ = conn.send_event(false, request.requestor, EventMask::NO_EVENT, notify);
        let _ = conn.flush();
    }
}

/// The clipboard's text now, read from its owner within half a second.
pub fn read() -> Option<String> {
    let (conn, screen) = x11rb::connect(None).ok()?;
    let root = conn.setup().roots.get(screen)?.root;
    let atoms = atoms(&conn)?;
    let window = conn.generate_id().ok()?;
    conn.create_window(
        0,
        window,
        root,
        0,
        0,
        1,
        1,
        0,
        WindowClass::INPUT_ONLY,
        0,
        &CreateWindowAux::new(),
    )
    .ok()?;
    conn.convert_selection(window, atoms.clipboard, atoms.utf8, atoms.property, x11rb::CURRENT_TIME)
        .ok()?;
    conn.flush().ok()?;
    let deadline = Instant::now() + Duration::from_millis(500);
    while Instant::now() < deadline {
        match conn.poll_for_event().ok()? {
            Some(Event::SelectionNotify(notify)) => {
                if notify.property == 0 {
                    return None;
                }
                let reply = conn
                    .get_property(true, window, atoms.property, AtomEnum::ANY, 0, 64 * 1024 * 1024)
                    .ok()?
                    .reply()
                    .ok()?;
                return Some(String::from_utf8_lossy(&reply.value).into_owned());
            }
            Some(_) => {}
            None => std::thread::sleep(Duration::from_millis(5)),
        }
    }
    None
}

/// Nothing is left half-borrowed across an exit: the old text is served again right after
/// each paste, and an exit drops this helper's ownership with its connection.
pub fn restore_pending() {}
