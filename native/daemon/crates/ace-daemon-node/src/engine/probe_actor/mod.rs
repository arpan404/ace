// SPDX-License-Identifier: Apache-2.0
//! The probe's actor (E5.2 step 15), compiled only with the `engine-probe` cargo feature: a
//! scripted repository and link set over E5.2's real actor, and the hooks the seam tests drive.
//! It is scripting, never thread behaviour.

mod hooks;
mod log;
mod repo;
mod script;
mod session;

use std::collections::HashMap;
use std::rc::Rc;

pub use log::ProbeLog;

/// The probe's per-thread logs.
#[derive(Default)]
pub struct ProbeThreads {
    pub logs: HashMap<String, Rc<ProbeLog>>,
    pub sessions: HashMap<u64, Rc<ProbeLog>>,
}
