// SPDX-License-Identifier: Apache-2.0
//! Accepted commands' lanes. Ports `apps/daemon/src/command-lanes.ts`: commands that touch the
//! same thread (or workspace) run one at a time in arrival order, whichever socket of the
//! device carried them; unrelated work does not wait. A replay after a reconnect lands behind
//! the attempt it repeats, so it finds that attempt's receipt instead of racing it.
//!
//! The tasks themselves are the shell's: it runs a [`LaneRun`] whose `start` is set, and calls
//! [`CommandLanes::finished`] when that task settles, which names the next run to start. Nothing
//! here owns a task, a thread or a timer.

use std::collections::{HashMap, VecDeque};

use ace_json::Value;

use crate::js::field;

/// `commandLane(command, device)`: the order key of a command.
pub fn command_lane(command: &Value, device: &str) -> String {
    let payload = field(command, "payload").unwrap_or(command);
    let link = field(payload, "link");
    let thread = match field(payload, "threadId") {
        Some(Value::String(thread)) => Some(thread.as_str().to_owned()),
        _ => match link.and_then(|link| field(link, "threadId")) {
            Some(Value::String(thread)) => Some(thread.as_str().to_owned()),
            Some(other) => Some(js_string(other)),
            None => None,
        },
    };
    if let Some(thread) = thread {
        return format!("{device}\0thread\0{thread}");
    }
    if let Some(Value::String(workspace)) = field(payload, "workspaceId") {
        return format!("{device}\0workspace\0{}", workspace.as_str());
    }
    format!("{device}\0device")
}

/// JavaScript's `String(value)` for the non-string a link may carry.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(seen) => seen.to_string(),
        Value::Number(seen) => {
            let mut out = String::new();
            ace_json::write_number(&mut out, seen.value());
            out
        }
        Value::String(seen) => seen.as_str().to_owned(),
        Value::Array(_) | Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// One command's place in its lane.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaneRun {
    /// Unique per `run` call, so the shell can key its task by it.
    pub id: u64,
    pub lane: String,
    pub device: String,
    pub command_id: String,
    /// True when the lane was idle: the shell starts this task now.
    pub start: bool,
}

/// Per-key FIFO chains for accepted commands, kept off the socket input queue so a slow
/// command (provider activation, git hooks, a long push) never holds liveness traffic behind it.
#[derive(Debug, Default)]
pub struct CommandLanes {
    /// Each lane's runs in arrival order, the first being (or starting) the active one.
    lanes: HashMap<String, VecDeque<u64>>,
    /// The run each lane is executing, while it is.
    active: HashMap<String, u64>,
    /// Every run by its id, for `finished` to retire.
    runs: HashMap<u64, LaneRun>,
    /// How many queued or executing runs each `(device, commandId)` has.
    pending: HashMap<String, usize>,
    next: u64,
}

impl CommandLanes {
    pub fn new() -> CommandLanes {
        CommandLanes::default()
    }

    /// `run(lane, device, commandId)`: queue one command behind earlier work on `lane`.
    pub fn run(&mut self, lane: &str, device: &str, command_id: &str) -> LaneRun {
        self.next += 1;
        let id = self.next;
        let start = !self.active.contains_key(lane);
        let run = LaneRun {
            id,
            lane: lane.to_owned(),
            device: device.to_owned(),
            command_id: command_id.to_owned(),
            start,
        };
        *self
            .pending
            .entry(format!("{device}\0{command_id}"))
            .or_insert(0) += 1;
        self.lanes.entry(lane.to_owned()).or_default().push_back(id);
        self.runs.insert(id, run.clone());
        if start {
            self.active.insert(lane.to_owned(), id);
        }
        run
    }

    /// The run settled, whichever way: retire it and name the lane's next run to start, if any.
    pub fn finished(&mut self, run: &LaneRun) -> Option<LaneRun> {
        let key = format!("{}\0{}", run.device, run.command_id);
        if let Some(count) = self.pending.get_mut(&key) {
            *count -= 1;
            if *count == 0 {
                self.pending.remove(&key);
            }
        }
        self.runs.remove(&run.id);
        let queue = self.lanes.get_mut(&run.lane)?;
        if queue.front() == Some(&run.id) {
            queue.pop_front();
        } else if let Some(index) = queue.iter().position(|id| *id == run.id) {
            queue.remove(index);
        }
        let Some(next) = queue.front().copied() else {
            self.lanes.remove(&run.lane);
            self.active.remove(&run.lane);
            return None;
        };
        // The lane's next run starts now.
        self.active.insert(run.lane.clone(), next);
        let mut next = self.runs.get(&next).cloned()?;
        next.start = true;
        Some(next)
    }

    /// True while a command is queued or executing on any lane.
    pub fn running(&self, device: &str, command_id: &str) -> bool {
        self.pending
            .contains_key(&format!("{device}\0{command_id}"))
    }

    /// How many runs are queued or executing.
    pub fn size(&self) -> usize {
        self.runs.len()
    }

    /// `settled()` without its promise: nothing is queued or executing.
    pub fn settled(&self) -> bool {
        self.runs.is_empty()
    }
}

/// `settledWithin`'s bound, as a pure predicate for a shell that races the task with a timer:
/// whether every run has settled by the time the timer fired.
pub fn settled_within(lanes: &CommandLanes) -> bool {
    lanes.settled()
}
