//! "ace is using <app>": a desktop notification with a Stop button while an agent acts in an
//! app. It is Linux's stand-in for two macOS affordances Wayland doesn't allow: the Esc that
//! stops the agent (the compositor's keyboard monitor serves only the screen reader) and the
//! marker drawn where the agent acts (no program may place an overlay over another app's
//! window). One notification per app helper, shown when a batch starts and withdrawn when the
//! keep-awake lease ends or the person presses Stop.
use crate::computer::cancel::StopSignal;
use futures_util::StreamExt;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use zbus::zvariant::Value;
use zbus::{Connection, MatchRule, MessageStream};

const DEST: &str = "org.freedesktop.Notifications";
const PATH: &str = "/org/freedesktop/Notifications";
const TIMEOUT: Duration = Duration::from_millis(800);
pub const STOP_ACTION: &str = "stop";

/// The shown notification's id and the notification server that owns it: only its signals
/// count, so no other program on the session bus can press Stop.
#[derive(Clone, Debug)]
struct Shown {
    id: u32,
    server: String,
}

#[derive(Clone)]
pub struct Notice {
    conn: Connection,
    shown: Arc<Mutex<Option<Shown>>>,
}

impl Notice {
    /// Listens for the notification's Stop and close, which press `stop` and forget it.
    pub async fn start(conn: Connection, stop: StopSignal) -> Self {
        let shown: Arc<Mutex<Option<Shown>>> = Arc::default();
        let notice = Self { conn: conn.clone(), shown: shown.clone() };
        let rule = MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .interface(DEST)
            .and_then(|rule| rule.path(PATH))
            .map(|rule| rule.build());
        if let Ok(rule) = rule {
            if let Ok(mut stream) = MessageStream::for_match_rule(rule, &conn, Some(16)).await {
                tokio::spawn(async move {
                    while let Some(Ok(message)) = stream.next().await {
                        let header = message.header();
                        let member = header.member().map(|m| m.as_str().to_owned()).unwrap_or_default();
                        let sender = header.sender().map(|s| s.as_str().to_owned());
                        let current = lock(&shown)
                            .clone()
                            .filter(|shown| sender.as_deref() == Some(shown.server.as_str()))
                            .map(|shown| shown.id);
                        match member.as_str() {
                            "ActionInvoked" => {
                                if let Ok((id, action)) = message.body().deserialize::<(u32, String)>() {
                                    if Some(id) == current && action == STOP_ACTION {
                                        stop.press();
                                    }
                                }
                            }
                            "NotificationClosed" => {
                                if let Ok((id, _reason)) = message.body().deserialize::<(u32, u32)>() {
                                    if Some(id) == current {
                                        *lock(&shown) = None;
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                });
            }
        }
        notice
    }

    /// Shows the notification for `app` unless it is already up.
    pub async fn show(&self, app: &str) {
        if lock(&self.shown).is_some() {
            return;
        }
        let mut hints: HashMap<&str, Value> = HashMap::new();
        hints.insert("urgency", Value::U8(1));
        // Stays in the notification list after a click, until the helper withdraws it.
        hints.insert("resident", Value::Bool(true));
        hints.insert("category", Value::from("presence"));
        let summary = format!("ace is using {app}");
        let body = "An agent is working in this app. Press Stop to end it.";
        let actions = [STOP_ACTION, "Stop"];
        let reply = tokio::time::timeout(
            TIMEOUT,
            self.conn.call_method(
                Some(DEST),
                PATH,
                Some(DEST),
                "Notify",
                &("ace", 0u32, "", summary.as_str(), body, &actions[..], hints, 0i32),
            ),
        )
        .await;
        if let Ok(Ok(reply)) = reply {
            let server = reply.header().sender().map(|s| s.as_str().to_owned());
            if let (Ok(id), Some(server)) = (reply.body().deserialize::<u32>(), server) {
                *lock(&self.shown) = Some(Shown { id, server });
            }
        }
    }

    pub async fn withdraw(&self) {
        let Some(Shown { id, .. }) = lock(&self.shown).take() else { return };
        let _ = tokio::time::timeout(
            TIMEOUT,
            self.conn.call_method(Some(DEST), PATH, Some(DEST), "CloseNotification", &(id,)),
        )
        .await;
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}
