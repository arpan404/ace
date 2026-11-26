// SPDX-License-Identifier: Apache-2.0
//! The channel's construction: one session, its queue and its gate.

use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{Arc, Mutex};

use ace_adapter_api::bridge::ReadGate;
use ace_adapter_api::bridge::queue::EventQueue;
use ace_json::JsString;

use crate::session::selection::Selection;
use crate::session::state::{Session, SessionConfig};

use super::super::LINE_LIMIT;
use super::super::ShellConfig;
use super::super::host::SharedHost;
use super::super::redact::redactor;
use super::{Core, Jobs, SessionChannel};

impl SessionChannel {
    pub fn new(
        shared: Arc<SharedHost>,
        tenant: u64,
        config: ShellConfig,
        stop: Arc<dyn Fn(String) + Send + Sync>,
    ) -> Arc<SessionChannel> {
        let gate = ReadGate::new();
        let queue = EventQueue::new(gate.clone());
        let host = Arc::clone(&shared.host);
        let cwd = config.cwd.clone();
        let redact = redactor(&config);
        let bearer = config.bearer.clone();
        let session = Session::new(SessionConfig {
            scope: config.scope,
            started: config.started,
            cwd: config.cwd,
            bearer: config.bearer.clone(),
            redact,
            foreign: Box::new(move |thread: &str| host.foreign(tenant, &JsString::from(thread))),
        });
        let channel = Arc::new(SessionChannel {
            tenant,
            shared: Arc::clone(&shared),
            stop,
            cwd,
            core: Mutex::new(Core {
                session,
                jobs: Jobs::default(),
                model: String::new(),
                selection: Selection::default(),
                open_operation: None,
                opened: false,
                close_operation: None,
                work_operation: None,
                permission_port: false,
                read_operations: Vec::new(),
            }),
            queue,
            gate,
            now: Mutex::new(config.started),
            line_limit: Arc::new(AtomicUsize::new(LINE_LIMIT)),
            bearer,
            drained: AtomicBool::new(false),
        });
        shared.add(Arc::clone(&channel));
        channel
    }
}
