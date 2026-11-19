//! The keyboard for typing in front: a keyboard-only RemoteDesktop portal session (ADR 0049
//! keeps every input on the portal). Its keys reach whichever window has the desktop's focus,
//! so `act_front.rs` uses it only after the agent chose to bring the app forward, and checks
//! the focus before each burst of keys.
//!
//! The first time, the person allows it in the portal's dialog; the request does not wait for
//! that, as with screenshots. The grant is remembered (persist mode 2) and restored silently
//! afterwards. A session is open only while a batch types in front and closes when the batch
//! ends, so the desktop's "being controlled" indicator shows only then.
use crate::computer::portal_call::{Dict, PATH, SERVICE, close, request, text};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::time::Duration;
use zbus::Connection;
use zbus::zvariant::{OwnedObjectPath, OwnedValue};

const DESK: &str = "org.freedesktop.portal.RemoteDesktop";
const KEYBOARD: u32 = 1;
/// How long the person has to answer the dialog before the request is abandoned.
const APPROVAL: Duration = Duration::from_secs(300);
/// evdev-free wake: a lone Shift does nothing in apps, and makes a new virtual keyboard
/// known to them before it carries text.
const SHIFT: u32 = 0xffe1;
const SETTLE: Duration = Duration::from_millis(150);

type Pending = tokio::task::JoinHandle<Result<Started, String>>;

struct Started {
    session: OwnedObjectPath,
    token: Option<String>,
}

pub struct Keyboard {
    conn: Connection,
    counter: Arc<AtomicU64>,
    token_file: Option<PathBuf>,
    token: Option<String>,
    session: Option<OwnedObjectPath>,
    pending: Option<Pending>,
}

/// Why typing in front can't happen now, for the agent.
pub fn approval_message(app: &str) -> String {
    format!(
        "The person must allow ace to use the keyboard in the dialog that just opened (on GNOME: turn on Allow Remote Interaction, keep Remember This Selection, then Share), then try again. Typing into {app} waits for that; background steps work meanwhile."
    )
}

pub fn declined_message(why: &str) -> String {
    format!(
        "Keyboard use was not allowed ({why}). Ask the person to type it, or try again to show the dialog again."
    )
}

pub fn unavailable_message(app: &str) -> String {
    format!(
        "This desktop lets no program use the keyboard (its portal has no RemoteDesktop; Hyprland's doesn't), so nothing can be typed into {app}. Ask the person to type it."
    )
}

/// Where the grant's restore token lives.
pub fn token_path(data_dir: &Path) -> PathBuf {
    data_dir.join("portal").join("computer-keyboard.token")
}

impl Keyboard {
    /// The portal's keyboard, when this desktop offers one.
    pub async fn connect(data_dir: Option<&Path>) -> Option<Self> {
        let conn = tokio::time::timeout(Duration::from_secs(3), Connection::session())
            .await
            .ok()?
            .ok()?;
        let reply = tokio::time::timeout(
            Duration::from_secs(5),
            conn.call_method(
                Some(SERVICE),
                PATH,
                Some("org.freedesktop.DBus.Properties"),
                "Get",
                &(DESK, "AvailableDeviceTypes"),
            ),
        )
        .await
        .ok()?
        .ok()?;
        let types: OwnedValue = reply.body().deserialize().ok()?;
        let types = u32::try_from(types).ok()?;
        let token_file = data_dir.map(token_path);
        let token = token_file
            .as_deref()
            .and_then(|path| crate::portal_token::read_token(path).ok().flatten());
        (types & KEYBOARD != 0).then(|| Self {
            conn,
            counter: Arc::new(AtomicU64::new(0)),
            token_file,
            token,
            session: None,
            pending: None,
        })
    }

    fn remember(&mut self, token: Option<String>) {
        if let (Some(path), Some(token)) = (&self.token_file, &token) {
            if let Err(error) = crate::portal_token::save_token(path, token) {
                eprintln!("computer: could not save the keyboard grant: {error}");
            }
        }
        if token.is_none() {
            if let Some(path) = &self.token_file {
                let _ = std::fs::remove_file(path);
            }
        }
        self.token = token;
    }

    pub fn is_open(&self) -> bool {
        self.session.is_some()
    }

    /// An open keyboard session, or the agent-facing reason there is none yet.
    pub async fn open(&mut self, app: &str) -> Result<(), String> {
        if self.session.is_some() {
            return Ok(());
        }
        let started = if let Some(handle) = self.pending.take() {
            if !handle.is_finished() {
                self.pending = Some(handle);
                return Err(approval_message(app));
            }
            match handle.await {
                Ok(Ok(started)) => started,
                Ok(Err(why)) => return Err(declined_message(&why)),
                Err(_) => return Err(declined_message("the dialog closed")),
            }
        } else {
            let had_token = self.token.is_some();
            match self.begin().await {
                Ok(started) => started,
                // The portal rejected the saved grant: ask the person afresh.
                Err(Some(_)) if had_token => {
                    self.remember(None);
                    match self.begin().await {
                        Ok(started) => started,
                        Err(None) => return Err(approval_message(app)),
                        Err(Some(why)) => return Err(declined_message(&why)),
                    }
                }
                Err(Some(why)) => return Err(declined_message(&why)),
                Err(None) => return Err(approval_message(app)),
            }
        };
        self.remember(started.token.clone().or_else(|| self.token.clone()));
        self.session = Some(started.session);
        // A new virtual keyboard can lose its first keys until apps know it.
        self.press(SHIFT).await.ok();
        tokio::time::sleep(SETTLE).await;
        Ok(())
    }

    /// `Err(None)`: a dialog is up and the person decides later.
    async fn begin(&mut self) -> Result<Started, Option<String>> {
        let wait = if self.token.is_some() {
            Duration::from_secs(4)
        } else {
            Duration::from_millis(1500)
        };
        let flow = start(self.conn.clone(), self.counter.clone(), self.token.clone());
        let mut handle = tokio::spawn(flow);
        match tokio::time::timeout(wait, &mut handle).await {
            Ok(Ok(Ok(started))) => Ok(started),
            Ok(Ok(Err(why))) => Err(Some(why)),
            Ok(Err(_)) => Err(Some("the portal request failed".into())),
            Err(_) => {
                self.pending = Some(handle);
                Err(None)
            }
        }
    }

    pub async fn key(&self, keysym: u32, pressed: bool) -> Result<(), String> {
        let session = self.session.as_ref().ok_or("no keyboard session")?;
        self.conn
            .call_method(
                Some(SERVICE),
                PATH,
                Some(DESK),
                "NotifyKeyboardKeysym",
                &(session, Dict::new(), keysym as i32, u32::from(pressed)),
            )
            .await
            .map(|_| ())
            .map_err(|e| format!("the keyboard stopped working ({e})"))
    }

    /// Presses and releases one key.
    pub async fn press(&self, keysym: u32) -> Result<(), String> {
        self.key(keysym, true).await?;
        self.key(keysym, false).await
    }

    /// Ends the session; the remembered grant stays for the next batch.
    pub async fn close(&mut self) {
        if let Some(session) = self.session.take() {
            close(&self.conn, &session).await;
        }
    }
}

/// CreateSession, SelectDevices (the keyboard only) and Start, which asks the person unless
/// the grant restores.
async fn start(conn: Connection, counter: Arc<AtomicU64>, token: Option<String>) -> Result<Started, String> {
    let mut create: Dict = HashMap::new();
    let id = counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    create.insert("session_handle_token".into(), text(&format!("ace_kb{id}")));
    let created = request(&conn, &counter, DESK, "CreateSession", None, create, Duration::from_secs(10)).await?;
    let session: String = created
        .get("session_handle")
        .and_then(|v| v.try_clone().ok())
        .and_then(|v| String::try_from(v).ok())
        .ok_or("the portal gave no session")?;
    let session = OwnedObjectPath::try_from(session).map_err(|e| e.to_string())?;
    let result = async {
        let mut select: Dict = HashMap::new();
        select.insert("types".into(), OwnedValue::from(KEYBOARD));
        select.insert("persist_mode".into(), OwnedValue::from(2u32));
        if let Some(token) = &token {
            select.insert("restore_token".into(), text(token));
        }
        request(&conn, &counter, DESK, "SelectDevices", Some(&session), select, APPROVAL).await?;
        let started = request(&conn, &counter, DESK, "Start", Some(&session), HashMap::new(), APPROVAL).await?;
        let devices = started
            .get("devices")
            .and_then(|v| v.try_clone().ok())
            .and_then(|v| u32::try_from(v).ok())
            .unwrap_or(0);
        if devices & KEYBOARD == 0 {
            return Err("the keyboard was not shared".to_owned());
        }
        let token = started
            .get("restore_token")
            .and_then(|v| v.try_clone().ok())
            .and_then(|v| String::try_from(v).ok());
        Ok(Started {
            session: session.clone(),
            token,
        })
    }
    .await;
    if result.is_err() {
        close(&conn, &session).await;
    }
    result
}
