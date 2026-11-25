// SPDX-License-Identifier: Apache-2.0
//! The host's shell: its sink, its diverted child's framing and its tenants.

use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, OnceLock};

use ace_adapter_api::bridge::queue::SessionEvent;
use ace_json::Value;
use ace_supervisor::divert::{ChildPorts, OutputConsumer};
use ace_supervisor::errors::NodeIoError;
use ace_supervisor::lines::LineFramer;
use ace_supervisor::spawn::{Delivered, OutputStream, RawExit};

use ace_adapter_api::util::{ElisionLimits, JsonElider};

use crate::session::host::{ChannelHandlers, Host, HostEffect, HostSink, Retirement};

use super::LINE_LIMIT;
use super::channel::SessionChannel;

/// The facade's operations and the host's calls share one id space; this keeps
/// them apart.
pub(super) const HOST_ID_BASE: u64 = 1 << 20;

/// One host's shell state: its ports, tenants, timers and catalogs.
pub struct SharedHost {
    pub id: u64,
    pub key: String,
    pub host: Arc<Host>,
    pub ports: Arc<OnceLock<ChildPorts>>,
    pub(super) active_write: Arc<Mutex<Option<u64>>>,
    pub(super) channels: Mutex<indexmap::IndexMap<u64, Arc<SessionChannel>>>,
    pub(super) owners: Mutex<indexmap::IndexMap<u64, Owner>>,
    pub(super) catalogs: Mutex<crate::session::tools::CodexCatalogCache>,
    pub(super) stop_failure: Mutex<Option<String>>,
    pub(super) retire_channel: Mutex<Option<Arc<SessionChannel>>>,
    pub(super) next_id: AtomicU64,
    pub(super) next_wake: AtomicU64,
}

pub(super) enum Owner {
    SessionCall {
        tenant: u64,
        call: u64,
    },
    History {
        tenant: u64,
        discovery: u64,
    },
    RateLimits {
        tenant: u64,
        call: u64,
    },
    FactsLocal {
        tenant: u64,
        operation: u64,
        call: u64,
    },
    LaunchConfig {
        tenant: u64,
        operation: u64,
    },
    Js {
        tenant: u64,
        operation: u64,
    },
}

impl SharedHost {
    pub fn new(id: u64, key: String, host: Host) -> SharedHost {
        SharedHost {
            id,
            key,
            host: Arc::new(host),
            ports: Arc::new(OnceLock::new()),
            active_write: Arc::new(Mutex::new(None)),
            channels: Mutex::new(indexmap::IndexMap::new()),
            owners: Mutex::new(indexmap::IndexMap::new()),
            catalogs: Mutex::new(crate::session::tools::CodexCatalogCache::new()),
            stop_failure: Mutex::new(None),
            retire_channel: Mutex::new(None),
            next_id: AtomicU64::new(HOST_ID_BASE),
            next_wake: AtomicU64::new(1),
        }
    }

    pub fn active_write(&self) -> Arc<Mutex<Option<u64>>> {
        Arc::clone(&self.active_write)
    }

    pub fn channel(&self, tenant: u64) -> Option<Arc<SessionChannel>> {
        self.channels.lock().ok()?.get(&tenant).cloned()
    }

    pub(super) fn add(&self, channel: Arc<SessionChannel>) {
        if let Ok(mut channels) = self.channels.lock() {
            channels.insert(channel.tenant, channel);
        }
    }

    pub(super) fn remove(&self, tenant: u64) {
        if let Ok(mut channels) = self.channels.lock() {
            channels.shift_remove(&tenant);
        }
    }

    pub fn first_channel(&self) -> Option<Arc<SessionChannel>> {
        self.channels.lock().ok()?.values().next().cloned()
    }

    fn settle(&self, id: u64, result: Result<Value, ace_supervisor::peer::PeerError>) {
        let owner = self
            .owners
            .lock()
            .ok()
            .and_then(|mut owners| owners.shift_remove(&id));
        match owner {
            Some(Owner::SessionCall { tenant, call }) => {
                if let Some(channel) = self.channel(tenant) {
                    let reply = as_reply(&result);
                    channel.settled_call(call, reply);
                }
            }
            Some(Owner::History { tenant, discovery }) => {
                if let Some(channel) = self.channel(tenant) {
                    let reply = as_reply(&result);
                    channel.history_settled(discovery, reply);
                }
            }
            Some(Owner::FactsLocal {
                tenant,
                operation,
                call,
            }) => {
                if let Some(channel) = self.channel(tenant) {
                    let reply = as_reply(&result);
                    channel.facts_settled(operation, call, reply);
                }
            }
            Some(Owner::RateLimits { tenant, call }) => {
                if let Some(channel) = self.channel(tenant) {
                    let reply = as_reply(&result);
                    channel.rate_limits_settled(call, reply);
                }
            }
            Some(Owner::LaunchConfig { tenant, operation }) => {
                if let Some(channel) = self.channel(tenant) {
                    let reply = as_reply(&result);
                    channel.launch_config(operation, reply);
                }
            }
            Some(Owner::Js { tenant, operation }) => {
                if let Some(channel) = self.channel(tenant) {
                    channel.publish_settle(operation, result);
                }
            }
            None => {}
        }
    }

    fn timer(&self, key: &str, ms: f64) {
        if let Some(channel) = self.first_channel() {
            channel.publish(vec![SessionEvent::ArmTimer {
                key: key.to_owned(),
                ms,
            }]);
        }
    }

    fn cancel_timer(&self, key: &str) {
        if let Some(channel) = self.first_channel() {
            channel.publish(vec![SessionEvent::CancelTimer {
                key: key.to_owned(),
            }]);
        }
    }
}

fn as_reply(result: &Result<Value, ace_supervisor::peer::PeerError>) -> Result<&Value, &str> {
    match result {
        Ok(value) => Ok(value),
        Err(error) => Err(error.message()),
    }
}

/// The host's sink: routes each decided effect in the host's order.
pub struct HostShell {
    pub shared: Arc<SharedHost>,
    stop: Arc<dyn Fn(String) + Send + Sync>,
}

impl HostShell {
    pub fn new(shared: Arc<SharedHost>, stop: Arc<dyn Fn(String) + Send + Sync>) -> Arc<HostShell> {
        Arc::new(HostShell { shared, stop })
    }
}

impl HostSink for HostShell {
    fn effect(&self, host: &Host, effect: HostEffect) {
        if host.hand_over(&effect, |tenant| {
            self.shared
                .channel(tenant)
                .map(|channel| channel as Arc<dyn ChannelHandlers>)
        }) {
            return;
        }
        match effect {
            HostEffect::Write { wire, ticket } => {
                if let Ok(mut active) = self.shared.active_write.lock() {
                    *active = Some(ticket);
                }
                if let Some(ports) = self.shared.ports.get() {
                    let _ = ports.stdin.write(wire);
                }
            }
            HostEffect::ArmTimer { key, ms } => self.shared.timer(&key, ms),
            HostEffect::CancelTimer { key } => self.shared.cancel_timer(&key),
            HostEffect::Settle { id, result } => self.shared.settle(id, result),
            HostEffect::Retire { reason, .. } => {
                let body = format!(
                    "{{\"host\":{},\"key\":{},\"reason\":\"{}\"}}",
                    self.shared.id,
                    Value::from(self.shared.key.clone()).to_json(),
                    reason.as_str()
                );
                (self.stop)(body);
            }
            HostEffect::Retiring { .. } => {
                let failure = self
                    .shared
                    .stop_failure
                    .lock()
                    .ok()
                    .and_then(|slot| slot.clone());
                if let Some(message) = failure
                    && let Some(channel) = self
                        .shared
                        .retire_channel
                        .lock()
                        .ok()
                        .and_then(|mut slot| slot.take())
                {
                    channel.retired(Err(message));
                }
            }
            HostEffect::Retired => {
                if let Some(channel) = self
                    .shared
                    .retire_channel
                    .lock()
                    .ok()
                    .and_then(|mut slot| slot.take())
                {
                    channel.retired(Ok(()));
                }
            }
            HostEffect::Opened { tenant } => {
                if let Some(channel) = self.shared.channel(tenant) {
                    channel.open_ready();
                }
            }
            HostEffect::OpenFailed { tenant, message } => {
                if let Some(channel) = self.shared.channel(tenant) {
                    channel.open_failed(&message);
                    self.shared.remove(tenant);
                }
            }
            HostEffect::Exited { tenant, exit } => {
                if let Some(channel) = self.shared.channel(tenant) {
                    channel.host_exited(&exit);
                }
                self.shared.remove(tenant);
            }
            HostEffect::DetachFailed {
                tenant,
                reason,
                message,
            } => {
                let _ = reason;
                if let Some(channel) = self.shared.channel(tenant) {
                    channel.detach_failed(&message);
                }
            }
            HostEffect::Frame { .. }
            | HostEffect::Notification { .. }
            | HostEffect::ServerRequest { .. }
            | HostEffect::AdmissionFailed { .. }
            | HostEffect::Dropped { .. }
            | HostEffect::Malformed { .. }
            | HostEffect::Stderr { .. }
            | HostEffect::Error { .. } => {}
        }
    }

    fn stop(&self, _host: &Host, reason: Retirement, _awaited: bool) {
        let body = format!(
            "{{\"host\":{},\"key\":{},\"reason\":\"{}\"}}",
            self.shared.id,
            Value::from(self.shared.key.clone()).to_json(),
            reason.as_str()
        );
        (self.stop)(body);
    }
}

/// The framed stdout/stderr of one diverted child.
pub struct HostConsumer {
    host: Arc<Host>,
    pub(super) active_write: Arc<Mutex<Option<u64>>>,
    stdout: Mutex<Framing>,
    stderr: Mutex<LineFramer>,
}

struct Framing {
    elider: JsonElider,
    framer: LineFramer,
}

impl HostConsumer {
    pub fn new(
        host: Arc<Host>,
        active_write: Arc<Mutex<Option<u64>>>,
        elision: ElisionLimits,
    ) -> Result<HostConsumer, ace_adapter_api::error::AdapterApiError> {
        Ok(HostConsumer {
            host,
            active_write,
            stdout: Mutex::new(Framing {
                elider: JsonElider::new(elision)?,
                framer: LineFramer::new(LINE_LIMIT),
            }),
            stderr: Mutex::new(LineFramer::new(LINE_LIMIT)),
        })
    }
}

impl OutputConsumer for HostConsumer {
    fn output(&self, stream: OutputStream, bytes: Vec<u8>, delivered: Delivered) {
        match stream {
            OutputStream::Stdout => {
                if let Ok(mut framing) = self.stdout.lock() {
                    let mut elided = Vec::with_capacity(bytes.len());
                    framing.elider.push(&bytes, &mut elided);
                    if let Ok(lines) = framing.framer.push(&elided)
                        && lines.count > 0
                    {
                        for line in lines.text.split('\n') {
                            self.host.line(line);
                        }
                    }
                }
            }
            OutputStream::Stderr => {
                if let Ok(mut framer) = self.stderr.lock()
                    && let Ok(lines) = framer.push(&bytes)
                    && lines.count > 0
                {
                    for line in lines.text.split('\n') {
                        self.host.stderr_line(line);
                    }
                }
            }
        }
        self.host.answer_delivery(delivered);
    }

    fn end(&self, _stream: OutputStream) {}

    fn stdin_written(&self) {
        let ticket = self
            .active_write
            .lock()
            .ok()
            .and_then(|mut active| active.take());
        if let Some(ticket) = ticket {
            self.host.written(ticket);
        }
    }

    fn stdin_error(&self, error: NodeIoError) {
        self.host
            .stderr_line(&format!("Codex app-server stdin failed: {error:?}"));
    }

    fn exit(&self, exit: RawExit) {
        self.host.exit(exit);
    }

    fn close(&self, exit: RawExit) {
        self.host.closed(exit);
    }
}
