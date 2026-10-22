//! Wayland screenshots through the xdg-desktop-portal ScreenCast interface, never a
//! compositor-private API (ADR 0049). Each screenshot opens a portal session from the app's
//! restore token, takes one PipeWire frame and closes it, so nothing streams in between.
//! A desktop that sends a window's picture only when its screen redraws (Hyprland) may send
//! none to a new session; that session stays open, unused for at most `KEEP`, so the next look
//! has the picture from the latest redraw.
//! The first time, the person picks the window in the portal's dialog; the request does not
//! wait for that: it returns the outline and asks the agent to look again once approved.
use crate::computer::image::Rgb;
use crate::computer::pw_frame::{NO_FRAME, Watch};
use futures_util::StreamExt;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};
use zbus::{Connection, MatchRule, MessageStream, message::Type};

const SERVICE: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
const MONITOR: u32 = 1;
const WINDOW: u32 = 2;
/// How long the person has to answer the dialog before the session is abandoned.
const APPROVAL: Duration = Duration::from_secs(300);
/// How long a new stream may take to send its first picture.
const FIRST_FRAME: Duration = Duration::from_secs(3);
/// How long a stream that is waiting for the desktop to redraw stays open without a look.
const KEEP: Duration = Duration::from_secs(120);

type Dict = HashMap<String, OwnedValue>;

/// A frame and the logical size of what it shows.
pub struct Frame {
    pub picture: Rgb,
    pub logical: (u32, u32),
    /// The frame is exactly one window (not a whole monitor).
    pub window: bool,
}

struct Started {
    session: OwnedObjectPath,
    node: u32,
    logical: Option<(u32, u32)>,
    token: Option<String>,
}

pub struct ScreenCast {
    conn: Connection,
    sources: u32,
    cursor_modes: u32,
    data_dir: Option<PathBuf>,
    tokens: HashMap<String, String>,
    pending: HashMap<String, tokio::task::JoinHandle<Result<Started, String>>>,
    /// Open sessions whose stream waits on the desktop to redraw, by token key.
    kept: HashMap<String, Kept>,
    counter: Arc<AtomicU64>,
}

/// A session kept open because its desktop sends pictures only on redraw.
struct Kept {
    session: OwnedObjectPath,
    logical: Option<(u32, u32)>,
    watch: Arc<Watch>,
}

/// Where an app's restore token lives: `<data>/portal/computer-<key>.token`, with the key
/// reduced to file-name-safe characters.
pub fn token_path(data_dir: &Path, key: &str) -> PathBuf {
    let safe: String = key
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    data_dir.join("portal").join(format!("computer-{safe}.token"))
}

/// The size node positions are measured in. The portal's logical stream size, when it has the
/// picture's shape (a HiDPI frame has more pixels than logical points); else the picture's
/// own size (GNOME reports the whole buffer for a window cropped out of it).
pub fn logical_size(stream: Option<(u32, u32)>, picture: (u32, u32)) -> (u32, u32) {
    match stream {
        Some((w, h)) if w > 0 && h > 0 && picture.1 > 0 => {
            let shape = |w: u32, h: u32| f64::from(w) / f64::from(h);
            if (shape(w, h) - shape(picture.0, picture.1)).abs() < 0.02 {
                (w, h)
            } else {
                picture
            }
        }
        _ => picture,
    }
}

pub fn approval_message(app: &str) -> String {
    format!(
        "The person must approve screen sharing for {app} in the screen-sharing dialog that just opened (choose the {app} window and allow it to be remembered), then look again. The outline works meanwhile."
    )
}

pub fn declined_message(app: &str, why: &str) -> String {
    format!(
        "Screen sharing for {app} was not approved ({why}). Work from the outline; asking for a screenshot again opens the dialog again."
    )
}

/// Sharing is approved but the stream stayed empty. Some compositors (Hyprland with
/// xdg-desktop-portal-hyprland 1.3) hand over a window's picture only when that screen next
/// redraws, so an unchanged desktop, or one whose display is asleep, sends none.
pub fn still_message(app: &str) -> String {
    format!(
        "No screenshot of {app}: screen sharing is approved, but the desktop sent no picture because nothing on that screen has redrawn since (or its display is asleep). Look again after the app changes, e.g. after your next action; the outline works meanwhile."
    )
}

fn text(value: &str) -> OwnedValue {
    OwnedValue::try_from(Value::from(value)).unwrap_or_else(|_| OwnedValue::from(0u32))
}

impl ScreenCast {
    /// The portal, when this session has one that can capture.
    pub async fn connect(data_dir: Option<PathBuf>) -> Option<Self> {
        let conn = tokio::time::timeout(Duration::from_secs(3), Connection::session())
            .await
            .ok()?
            .ok()?;
        let property = |name: &'static str| {
            let conn = conn.clone();
            async move {
                let reply = conn
                    .call_method(
                        Some(SERVICE),
                        PATH,
                        Some("org.freedesktop.DBus.Properties"),
                        "Get",
                        &("org.freedesktop.portal.ScreenCast", name),
                    )
                    .await
                    .ok()?;
                let value: OwnedValue = reply.body().deserialize().ok()?;
                u32::try_from(value).ok()
            }
        };
        let sources = tokio::time::timeout(Duration::from_secs(5), property("AvailableSourceTypes"))
            .await
            .ok()??;
        let cursor_modes = property("AvailableCursorModes").await.unwrap_or(0);
        (sources & (MONITOR | WINDOW) != 0).then(|| Self {
            conn,
            sources,
            cursor_modes,
            data_dir,
            tokens: HashMap::new(),
            pending: HashMap::new(),
            kept: HashMap::new(),
            counter: Arc::new(AtomicU64::new(0)),
        })
    }

    fn window_sources(&self) -> bool {
        self.sources & WINDOW != 0
    }

    fn key(&self, app_id: &str) -> String {
        if self.window_sources() {
            app_id.to_owned()
        } else {
            "monitor".into()
        }
    }

    fn load_token(&self, key: &str) -> Option<String> {
        if let Some(token) = self.tokens.get(key) {
            return Some(token.clone());
        }
        let dir = self.data_dir.as_ref()?;
        crate::portal_token::read_token(&token_path(dir, key)).ok().flatten()
    }

    fn store_token(&mut self, key: &str, token: Option<String>) {
        match token {
            Some(token) => {
                if let Some(dir) = &self.data_dir {
                    if let Err(error) = crate::portal_token::save_token(&token_path(dir, key), &token) {
                        eprintln!("computer: could not save the screen-sharing token: {error}");
                    }
                }
                self.tokens.insert(key.to_owned(), token);
            }
            None => {
                self.tokens.remove(key);
                if let Some(dir) = &self.data_dir {
                    let _ = std::fs::remove_file(token_path(dir, key));
                }
            }
        }
    }

    /// One picture of the app's window. `Err` is the model-facing reason there is none.
    pub async fn capture(&mut self, app_id: &str, app_name: &str) -> Result<Frame, String> {
        let key = self.key(app_id);
        if let Some(kept) = self.kept.remove(&key) {
            if !kept.watch.ended() {
                return self.from_kept(key, kept, app_name).await;
            }
            close(&self.conn, &kept.session).await;
        }
        let started = if let Some(handle) = self.pending.remove(&key) {
            if !handle.is_finished() {
                self.pending.insert(key, handle);
                return Err(approval_message(app_name));
            }
            match handle.await {
                Ok(Ok(started)) => started,
                Ok(Err(why)) => return Err(declined_message(app_name, &why)),
                Err(_) => return Err(declined_message(app_name, "the dialog closed")),
            }
        } else {
            let token = self.load_token(&key);
            let had_token = token.is_some();
            match self.begin(&key, token).await {
                Ok(started) => started,
                // The portal rejected the saved token outright: ask the person afresh.
                Err(Some(_)) if had_token => {
                    self.store_token(&key, None);
                    match self.begin(&key, None).await {
                        Ok(started) => started,
                        Err(None) => return Err(approval_message(app_name)),
                        Err(Some(why)) => return Err(declined_message(app_name, &why)),
                    }
                }
                Err(Some(why)) => return Err(declined_message(app_name, &why)),
                Err(None) => return Err(approval_message(app_name)),
            }
        };
        self.store_token(&key, started.token.clone());
        let watch = match self.open_stream(&started).await {
            Ok(watch) => Arc::new(watch),
            Err(why) => {
                close(&self.conn, &started.session).await;
                return Err(why);
            }
        };
        let kept = Kept {
            session: started.session,
            logical: started.logical,
            watch,
        };
        match latest(&kept.watch, FIRST_FRAME).await {
            Ok(picture) => {
                close(&self.conn, &kept.session).await;
                Ok(self.frame(picture, kept.logical))
            }
            Err(e) if e == NO_FRAME => {
                self.kept.insert(key, kept);
                Err(still_message(app_name))
            }
            Err(e) => {
                close(&self.conn, &kept.session).await;
                Err(stream_message(&e))
            }
        }
    }

    /// A look through a kept session: the picture from the desktop's latest redraw. The
    /// session stays open, since a new one would again wait for a redraw.
    async fn from_kept(&mut self, key: String, kept: Kept, app_name: &str) -> Result<Frame, String> {
        match latest(&kept.watch, Duration::from_secs(1)).await {
            Ok(picture) => {
                let frame = self.frame(picture, kept.logical);
                self.kept.insert(key, kept);
                Ok(frame)
            }
            Err(e) if e == NO_FRAME => {
                self.kept.insert(key, kept);
                Err(still_message(app_name))
            }
            Err(e) => {
                close(&self.conn, &kept.session).await;
                Err(stream_message(&e))
            }
        }
    }

    fn frame(&self, picture: Rgb, logical: Option<(u32, u32)>) -> Frame {
        let logical = logical_size(logical, (picture.width, picture.height));
        Frame {
            picture,
            logical,
            window: self.window_sources(),
        }
    }

    /// Starts a portal session. `Err(None)`: a dialog is up and the person decides later (the
    /// session stays pending under `key`); `Err(Some(why))`: it failed.
    async fn begin(&mut self, key: &str, token: Option<String>) -> Result<Started, Option<String>> {
        let wait = if token.is_some() {
            Duration::from_secs(4)
        } else {
            Duration::from_millis(1500)
        };
        let flow = start(self.conn.clone(), self.counter.clone(), self.select_options(token));
        let mut handle = tokio::spawn(flow);
        match tokio::time::timeout(wait, &mut handle).await {
            Ok(Ok(Ok(started))) => Ok(started),
            Ok(Ok(Err(why))) => Err(Some(why)),
            Ok(Err(_)) => Err(Some("the portal request failed".into())),
            Err(_) => {
                // A dialog is up (first use, or a revoked token): the person decides later.
                self.pending.insert(key.to_owned(), handle);
                Err(None)
            }
        }
    }

    fn select_options(&self, token: Option<String>) -> Dict {
        let mut options: Dict = HashMap::new();
        let source = if self.window_sources() { WINDOW } else { MONITOR };
        options.insert("types".into(), OwnedValue::from(source));
        options.insert("multiple".into(), OwnedValue::from(false));
        // Hidden cursor when offered; the agent's pictures never need the person's pointer.
        if self.cursor_modes & 1 != 0 {
            options.insert("cursor_mode".into(), OwnedValue::from(1u32));
        }
        options.insert("persist_mode".into(), OwnedValue::from(2u32));
        if let Some(token) = token {
            options.insert("restore_token".into(), text(&token));
        }
        options
    }

    /// Starts reading the session's stream.
    async fn open_stream(&self, started: &Started) -> Result<Watch, String> {
        let reply = self
            .conn
            .call_method(
                Some(SERVICE),
                PATH,
                Some("org.freedesktop.portal.ScreenCast"),
                "OpenPipeWireRemote",
                &(&started.session, Dict::new()),
            )
            .await
            .map_err(|e| format!("The screen-sharing stream could not be opened ({e}). Use the outline."))?;
        let fd: zbus::zvariant::OwnedFd = reply
            .body()
            .deserialize()
            .map_err(|e| format!("The screen-sharing stream could not be opened ({e})."))?;
        let fd: std::os::fd::OwnedFd = fd.into();
        Ok(Watch::start(fd, started.node, KEEP))
    }
}

/// The stream's latest picture, waiting up to `timeout` for a first one.
async fn latest(watch: &Arc<Watch>, timeout: Duration) -> Result<Rgb, String> {
    let watch = watch.clone();
    tokio::task::spawn_blocking(move || watch.latest(timeout))
        .await
        .map_err(|_| "The screenshot was interrupted.".to_owned())?
}

fn stream_message(error: &str) -> String {
    format!("No picture came from the screen-sharing stream ({error}). Use the outline.")
}

/// Closing never holds up a look: a backend still waiting on its chooser can't answer it.
const CLOSE_WAIT: Duration = Duration::from_secs(2);

async fn close(conn: &Connection, session: &OwnedObjectPath) {
    let call = conn.call_method(
        Some(SERVICE),
        session.as_str(),
        Some("org.freedesktop.portal.Session"),
        "Close",
        &(),
    );
    let _ = tokio::time::timeout(CLOSE_WAIT, call).await;
}

/// CreateSession, SelectSources and Start. Unless the token restores, the portal asks the
/// person at Start (GNOME, KDE) or already at SelectSources (xdg-desktop-portal-hyprland).
async fn start(conn: Connection, counter: Arc<AtomicU64>, select: Dict) -> Result<Started, String> {
    let mut create: Dict = HashMap::new();
    create.insert(
        "session_handle_token".into(),
        text(&format!("ace_cu{}", counter.fetch_add(1, Ordering::Relaxed))),
    );
    let created = request(&conn, &counter, "CreateSession", None, create, Duration::from_secs(10)).await?;
    let session: String = created
        .get("session_handle")
        .and_then(|v| v.try_clone().ok())
        .and_then(|v| String::try_from(v).ok())
        .ok_or("the portal gave no session")?;
    let session = OwnedObjectPath::try_from(session).map_err(|e| e.to_string())?;
    let result = async {
        request(
            &conn,
            &counter,
            "SelectSources",
            Some(&session),
            select,
            // GNOME asks the person at Start; xdg-desktop-portal-hyprland already here.
            APPROVAL,
        )
        .await?;
        let started = request(&conn, &counter, "Start", Some(&session), HashMap::new(), APPROVAL).await?;
        let streams: Vec<(u32, Dict)> = started
            .get("streams")
            .and_then(|v| v.try_clone().ok())
            .and_then(|v| v.try_into().ok())
            .ok_or("the portal gave no stream")?;
        let (node, properties) = streams.into_iter().next().ok_or("the portal gave no stream")?;
        let logical = properties
            .get("size")
            .and_then(|v| v.try_clone().ok())
            .and_then(|v| <(i32, i32)>::try_from(v).ok())
            .filter(|(w, h)| *w > 0 && *h > 0)
            .map(|(w, h)| (w as u32, h as u32));
        let token = started
            .get("restore_token")
            .and_then(|v| v.try_clone().ok())
            .and_then(|v| String::try_from(v).ok());
        Ok(Started {
            session: session.clone(),
            node,
            logical,
            token,
        })
    }
    .await;
    if result.is_err() {
        close(&conn, &session).await;
    }
    result
}

/// One portal request: subscribe to its Response, call, and wait for the answer.
async fn request(
    conn: &Connection,
    counter: &AtomicU64,
    method: &str,
    session: Option<&OwnedObjectPath>,
    mut options: Dict,
    wait: Duration,
) -> Result<Dict, String> {
    let token = format!("ace_cu{}", counter.fetch_add(1, Ordering::Relaxed));
    options.insert("handle_token".into(), text(&token));
    let sender = conn
        .unique_name()
        .ok_or("no bus name")?
        .as_str()
        .trim_start_matches(':')
        .replace('.', "_");
    let handle = format!("/org/freedesktop/portal/desktop/request/{sender}/{token}");
    let rule = MatchRule::builder()
        .msg_type(Type::Signal)
        .interface("org.freedesktop.portal.Request")
        .and_then(|b| b.member("Response"))
        .and_then(|b| b.path(handle.as_str()))
        .map_err(|e| e.to_string())?
        .build();
    let mut responses = MessageStream::for_match_rule(rule, conn, Some(4))
        .await
        .map_err(|e| e.to_string())?;
    let interface = Some("org.freedesktop.portal.ScreenCast");
    let call = match (method, session) {
        ("CreateSession", _) => {
            conn.call_method(Some(SERVICE), PATH, interface, method, &(options,))
                .await
        }
        ("Start", Some(session)) => {
            conn.call_method(Some(SERVICE), PATH, interface, method, &(session, "", options))
                .await
        }
        (_, Some(session)) => {
            conn.call_method(Some(SERVICE), PATH, interface, method, &(session, options))
                .await
        }
        _ => return Err("no session".into()),
    };
    call.map_err(|e| format!("the portal refused {method}: {e}"))?;
    let message = match tokio::time::timeout(wait, responses.next()).await {
        Ok(Some(Ok(message))) => message,
        _ => {
            let close = conn.call_method(
                Some(SERVICE),
                handle.as_str(),
                Some("org.freedesktop.portal.Request"),
                "Close",
                &(),
            );
            let _ = tokio::time::timeout(CLOSE_WAIT, close).await;
            return Err("nobody answered the dialog".into());
        }
    };
    let (code, results): (u32, Dict) = message.body().deserialize().map_err(|e| e.to_string())?;
    match code {
        0 => Ok(results),
        1 => Err("the person cancelled the dialog".into()),
        _ => Err("the portal ended the request".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_app_keeps_its_own_private_token_file() {
        let dir = Path::new("/data/screen");
        assert_eq!(
            token_path(dir, "org.gnome.Calculator"),
            Path::new("/data/screen/portal/computer-org.gnome.Calculator.token")
        );
        assert_eq!(
            token_path(dir, "../evil/app"),
            Path::new("/data/screen/portal/computer-.._evil_app.token")
        );
    }

    #[test]
    fn marks_use_logical_points_on_hidpi_and_the_picture_when_the_stream_size_is_the_buffer() {
        assert_eq!(logical_size(Some((360, 600)), (720, 1200)), (360, 600));
        assert_eq!(logical_size(Some((1280, 800)), (370, 616)), (370, 616));
        assert_eq!(logical_size(None, (370, 616)), (370, 616));
    }

    #[test]
    fn the_approval_message_names_the_app_and_says_what_to_do() {
        let message = approval_message("Calculator");
        assert!(message.contains("approve screen sharing for Calculator"));
        assert!(message.contains("look again"));
    }
}
