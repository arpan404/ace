//! Calls on xdg-desktop-portal's session interfaces: each method answers through a Request
//! object's Response signal, possibly after the person has answered a dialog.
use futures_util::StreamExt;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};
use zbus::{Connection, MatchRule, MessageStream, message::Type};

pub const SERVICE: &str = "org.freedesktop.portal.Desktop";
pub const PATH: &str = "/org/freedesktop/portal/desktop";

pub type Dict = HashMap<String, OwnedValue>;

pub fn text(value: &str) -> OwnedValue {
    OwnedValue::try_from(Value::from(value)).unwrap_or_else(|_| OwnedValue::from(0u32))
}

/// Closing never holds up a caller: a backend still waiting on its dialog can't answer it.
pub const CLOSE_WAIT: Duration = Duration::from_secs(2);

pub async fn close(conn: &Connection, session: &OwnedObjectPath) {
    let call = conn.call_method(
        Some(SERVICE),
        session.as_str(),
        Some("org.freedesktop.portal.Session"),
        "Close",
        &(),
    );
    let _ = tokio::time::timeout(CLOSE_WAIT, call).await;
}

/// One portal request on `interface` (ScreenCast, RemoteDesktop): subscribe to its Response,
/// call, and wait for the answer.
pub async fn request(
    conn: &Connection,
    counter: &AtomicU64,
    interface: &str,
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
    let interface = Some(interface);
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

