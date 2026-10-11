//! Continuously consume lifecycle signals, fencing cache reads against D-Bus order.
use crate::protocol::{Fault, Result, internal};
use futures_util::StreamExt;
use std::{collections::HashMap, sync::{Arc, atomic::{AtomicU64, Ordering}}};
use tokio::{sync::watch, task::JoinHandle};
use zbus::{Connection, Message, MessageStream, message::Sequence, zvariant::OwnedValue};

pub(crate) struct Lifecycle {
    generation: Arc<AtomicU64>,
    progress: watch::Receiver<Sequence>,
    task: JoinHandle<()>,
}
impl Lifecycle {
    pub async fn observe(conn: &Connection) -> Result<Self> {
        let mut stream = MessageStream::from(conn);
        if conn.is_bus() {
            let bus = zbus::fdo::DBusProxy::new(conn).await.map_err(internal)?;
            for interface in ["org.a11y.atspi.Event.Object", "org.freedesktop.DBus"] {
                let rule = zbus::MatchRule::builder()
                    .msg_type(zbus::message::Type::Signal)
                    .interface(interface).map_err(internal)?.build();
                bus.add_match_rule(rule).await.map_err(internal)?;
            }
        }
        let generation = Arc::new(AtomicU64::new(0));
        let changed = generation.clone();
        let (progress, received) = watch::channel(Sequence::default());
        let task = tokio::spawn(async move {
            while let Some(message) = stream.next().await {
                let Ok(message) = message else { break };
                if invalidates(&message) { changed.fetch_add(1, Ordering::SeqCst); }
                progress.send_replace(message.recv_position());
            }
            // Loss of the stream also loses proof of element continuity.
            changed.fetch_add(1, Ordering::SeqCst);
        });
        Ok(Self { generation, progress: received, task })
    }
    pub fn generation(&self) -> u64 { self.generation.load(Ordering::SeqCst) }
    pub async fn fence(&mut self, conn: &Connection, object: &(String, zbus::zvariant::OwnedObjectPath)) -> Result<()> {
        // A reply from the provider follows its earlier lifecycle signals. Wait
        // until the observer has processed that position, rather than trusting
        // task scheduling or a quiet interval.
        let reply = conn.call_method(
            Some(object.0.as_str()), object.1.as_str(),
            Some("org.a11y.atspi.Accessible"), "GetRoleName", &(),
        ).await.map_err(|e| Fault::new("target_gone", e.to_string()))?;
        let position = reply.recv_position();
        while *self.progress.borrow_and_update() < position {
            self.progress.changed().await.map_err(|_| Fault::new("target_gone", "Accessibility lifecycle stream ended"))?;
        }
        Ok(())
    }
}
impl Drop for Lifecycle { fn drop(&mut self) { self.task.abort(); } }

fn invalidates(message: &Message) -> bool {
    if message.message_type() != zbus::message::Type::Signal { return false; }
    let header = message.header();
    let interface = header.interface().map(|v| v.as_str());
    let member = header.member().map(|v| v.as_str());
    match (interface, member) {
        (Some("org.a11y.atspi.Event.Object"), Some("ChildrenChanged")) => true,
        (Some("org.a11y.atspi.Event.Object"), Some("StateChanged")) => {
            type Body = (String, i32, i32, OwnedValue, HashMap<String, OwnedValue>);
            // Unexpected lifecycle encoding loses continuity conservatively.
            message.body().deserialize::<Body>().map_or(true, |body| body.0 == "defunct" && body.1 != 0)
        }
        (Some("org.freedesktop.DBus"), Some("NameOwnerChanged")) => {
            message.body().deserialize::<(String, String, String)>()
                .map_or(true, |(name, _, owner)| name.starts_with(':') && owner.is_empty())
        }
        _ => false,
    }
}
