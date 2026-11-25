// SPDX-License-Identifier: Apache-2.0
//! `interruptTree`, `interruptOne`, `stopShells` and `stopTask`
//! (`session-commands.ts:171`-`:246`): the root's turn and then its background
//! shells, one thread at a time, with every failure kept and reported together.

use std::collections::VecDeque;

use ace_json::{Map, Value};
use indexmap::{IndexMap, IndexSet};

use super::{Flight, call_of, closed, settle};
use crate::session::frames::{Calls, Effect, Failure};
use crate::session::state::Session;
use crate::session::terminals::TerminalRead;

/// What `interruptTree` reports when a thread could not be interrupted.
pub(crate) const AGENT_TREE: &str = "Could not completely interrupt Codex agent tree";
/// What `stopTask` reports for a task it does not know.
pub(crate) const UNKNOWN_TASK: &str = "Unknown Codex background task";
/// What `stopShells` reports when the named terminal is gone.
pub(crate) const NO_TERMINAL: &str = "Background terminal is no longer listed";

/// One thread's interrupt, and the shells a cascade stops with it.
pub(crate) struct Tree {
    targets: VecDeque<String>,
    cascade: bool,
    message: &'static str,
    current: Option<Current>,
    /// Each thread's aggregate failure, kept for the tree's own report.
    failures: Vec<String>,
}

struct Current {
    thread: String,
    failures: Vec<String>,
    stage: Stage,
    read: Option<TerminalRead>,
    processes: VecDeque<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    /// The running turn's interrupt.
    Turn,
    /// The live terminals the cascade stops too.
    Read,
    /// One terminate per terminal.
    Terminate,
}

impl Session {
    /// `interrupt(target)`: the root's tree, or the named agent's.
    pub fn interrupt(&mut self, operation: u64, agent: Option<&str>, cascade: bool) -> Vec<Effect> {
        if self.is_closed() {
            return closed(operation);
        }
        let thread = match agent {
            Some(agent) if !agent.is_empty() && agent != "root" => agent.to_owned(),
            _ => self.root.clone(),
        };
        self.interrupt_tree(operation, &thread, cascade, AGENT_TREE)
    }

    /// `stopTask(task)`: a subagent's tree, or one background shell.
    pub fn stop_task(&mut self, operation: u64, task: &str) -> Vec<Effect> {
        if self.is_closed() {
            return closed(operation);
        }
        if let Some(agent) = task.strip_prefix(SUBAGENT) {
            return self.interrupt_tree(operation, agent, true, AGENT_TREE);
        }
        let item = task.strip_prefix(SHELL).unwrap_or(task);
        let Some(thread) = self.shells.get(item).cloned() else {
            return settle(operation, Err(Failure::failed(UNKNOWN_TASK)));
        };
        let (shells, effects) = Shells::start(&thread, Some(item), &mut self.calls);
        self.register_shells(operation, shells, effects)
    }

    /// One thread's interrupt with its own cascade, the same for `interrupt` and
    /// `stopTask`'s subagent.
    fn interrupt_tree(
        &mut self,
        operation: u64,
        thread: &str,
        cascade: bool,
        message: &'static str,
    ) -> Vec<Effect> {
        let mut tree = Tree {
            targets: tree_targets(&self.parents, thread, cascade),
            cascade,
            message,
            current: None,
            failures: Vec::new(),
        };
        let effects = tree.step(&mut self.calls, &self.active);
        self.register_interrupt(operation, tree, effects)
    }

    fn register_interrupt(
        &mut self,
        operation: u64,
        tree: Tree,
        effects: Vec<Effect>,
    ) -> Vec<Effect> {
        match effects.first().and_then(call_of) {
            Some(call) => {
                self.commands
                    .insert(call, Flight::Interrupt { operation, tree });
                effects
            }
            None => match tree.outcome() {
                Ok(()) => settle(operation, Ok(Value::Null)),
                Err(message) => settle(operation, Err(Failure::failed(message))),
            },
        }
    }

    fn register_shells(
        &mut self,
        operation: u64,
        shells: Shells,
        effects: Vec<Effect>,
    ) -> Vec<Effect> {
        match effects.first().and_then(call_of) {
            Some(call) => {
                self.commands
                    .insert(call, Flight::StopShells { operation, shells });
                effects
            }
            None => settle(operation, Ok(Value::Null)),
        }
    }

    /// An interrupt's reply: the next step, or the aggregate it ends on.
    pub(crate) fn interrupt_step(
        &mut self,
        operation: u64,
        mut tree: Tree,
        reply: Result<&Value, &str>,
    ) -> Vec<Effect> {
        let effects = tree.settled(&mut self.calls, &self.active, reply);
        self.register_interrupt(operation, tree, effects)
    }

    /// A shell stop's reply: the next terminal, or the outcome.
    pub(crate) fn stop_shells_step(
        &mut self,
        operation: u64,
        mut shells: Shells,
        reply: Result<&Value, &str>,
    ) -> Vec<Effect> {
        let effects = match shells.settled(&mut self.calls, reply) {
            Ok(effects) => effects,
            Err(message) => return settle(operation, Err(Failure::failed(message))),
        };
        self.register_shells(operation, shells, effects)
    }
}

/// `interruptTree`'s targets: the thread, and with a cascade every thread whose
/// chain of parents reaches it.
fn tree_targets(
    parents: &IndexMap<String, String>,
    thread: &str,
    cascade: bool,
) -> VecDeque<String> {
    let mut targets = VecDeque::from([thread.to_owned()]);
    if !cascade {
        return targets;
    }
    for child in parents.keys() {
        let mut seen: IndexSet<String> = IndexSet::new();
        let mut parent = parents.get(child).cloned();
        while let Some(current) = parent {
            if seen.contains(&current) {
                break;
            }
            if current == thread {
                targets.push_back(child.clone());
                break;
            }
            seen.insert(current.clone());
            parent = parents.get(&current).cloned();
        }
    }
    targets
}

impl Tree {
    fn outcome(&self) -> Result<(), String> {
        match self.failures.is_empty() {
            true => Ok(()),
            false => Err(self.message.to_owned()),
        }
    }

    /// The next step's effects, or none once every target is done.
    fn step(&mut self, calls: &mut Calls, active: &IndexMap<String, String>) -> Vec<Effect> {
        loop {
            if self.current.is_none() {
                let Some(thread) = self.targets.pop_front() else {
                    return Vec::new();
                };
                self.current = Some(Current {
                    thread,
                    failures: Vec::new(),
                    stage: Stage::Turn,
                    read: None,
                    processes: VecDeque::new(),
                });
            }
            let Some(current) = self.current.as_mut() else {
                return Vec::new();
            };
            match current.stage {
                Stage::Turn => {
                    if let Some(turn) = active.get(&current.thread).cloned() {
                        let call = calls.take();
                        let mut params = Map::new();
                        params.insert("threadId", Value::from(current.thread.clone()));
                        params.insert("turnId", Value::from(turn));
                        return vec![Effect::Request {
                            call,
                            method: "turn/interrupt".to_owned(),
                            params: Value::Object(params),
                            timeout_ms: None,
                        }];
                    }
                    current.stage = Stage::Read;
                }
                Stage::Read => {
                    if self.cascade {
                        let (read, effects) = TerminalRead::start(&current.thread, calls);
                        current.read = Some(read);
                        return effects;
                    }
                    current.stage = Stage::Terminate;
                }
                Stage::Terminate => {
                    if let Some(process) = current.processes.pop_front() {
                        let call = calls.take();
                        return vec![terminate_request(call, &current.thread, &process)];
                    }
                    let Some(current) = self.current.take() else {
                        return Vec::new();
                    };
                    if !current.failures.is_empty() {
                        self.failures.push(format!(
                            "Could not completely interrupt Codex thread {}",
                            current.thread
                        ));
                    }
                }
            }
        }
    }

    /// One reply for the step in flight, then the next step.
    fn settled(
        &mut self,
        calls: &mut Calls,
        active: &IndexMap<String, String>,
        reply: Result<&Value, &str>,
    ) -> Vec<Effect> {
        if let Some(current) = self.current.as_mut() {
            match current.stage {
                Stage::Turn => {
                    if let Err(message) = reply {
                        current.failures.push(message.to_owned());
                    }
                    current.stage = Stage::Read;
                }
                Stage::Read => {
                    let Some(read) = current.read.as_mut() else {
                        current.stage = Stage::Terminate;
                        return self.step(calls, active);
                    };
                    let more = read.settled(calls, reply);
                    if !more.is_empty() {
                        return more;
                    }
                    match read.outcome() {
                        Some(Ok(terminals)) => {
                            for terminal in terminals {
                                current.processes.push_back(terminal.process_id.clone());
                            }
                        }
                        Some(Err(message)) => current.failures.push(message.clone()),
                        None => return Vec::new(),
                    }
                    current.stage = Stage::Terminate;
                }
                Stage::Terminate => {
                    if let Err(message) = reply {
                        current.failures.push(message.to_owned());
                        current.processes.clear();
                    }
                }
            }
        }
        self.step(calls, active)
    }
}

/// One `stopShells` in flight: the thread's terminals, then one terminate each.
pub(crate) struct Shells {
    thread: String,
    /// Only this item's terminals, when one was named.
    item: Option<String>,
    read: TerminalRead,
    processes: VecDeque<String>,
}

impl Shells {
    fn start(thread: &str, item: Option<&str>, calls: &mut Calls) -> (Shells, Vec<Effect>) {
        let (read, effects) = TerminalRead::start(thread, calls);
        (
            Shells {
                thread: thread.to_owned(),
                item: item.map(|item| item.to_owned()),
                read,
                processes: VecDeque::new(),
            },
            effects,
        )
    }

    /// One reply: more effects to wait on, or none when the stop is done.
    fn settled(
        &mut self,
        calls: &mut Calls,
        reply: Result<&Value, &str>,
    ) -> Result<Vec<Effect>, String> {
        if self.read.outcome().is_none() {
            let more = self.read.settled(calls, reply);
            if !more.is_empty() {
                return Ok(more);
            }
            let terminals = match self.read.outcome() {
                Some(Ok(terminals)) => terminals,
                Some(Err(message)) => return Err(message.clone()),
                None => return Ok(Vec::new()),
            };
            let mut processes: IndexSet<String> = IndexSet::new();
            for terminal in terminals {
                if let Some(item) = &self.item
                    && terminal.item_id.as_deref() != Some(item.as_str())
                {
                    continue;
                }
                processes.insert(terminal.process_id.clone());
            }
            if self.item.is_some() && processes.is_empty() {
                return Err(NO_TERMINAL.to_owned());
            }
            self.processes = processes.into_iter().collect();
            return Ok(self.next(calls));
        }
        reply?;
        Ok(self.next(calls))
    }

    fn next(&mut self, calls: &mut Calls) -> Vec<Effect> {
        let Some(process) = self.processes.pop_front() else {
            return Vec::new();
        };
        let call = calls.take();
        vec![terminate_request(call, &self.thread, &process)]
    }
}

/// One `thread/backgroundTerminals/terminate`, interactive.
fn terminate_request(call: u64, thread: &str, process: &str) -> Effect {
    let mut params = Map::new();
    params.insert("threadId", Value::from(thread.to_owned()));
    params.insert("processId", Value::from(process.to_owned()));
    Effect::Request {
        call,
        method: "thread/backgroundTerminals/terminate".to_owned(),
        params: Value::Object(params),
        timeout_ms: None,
    }
}

/// `childKey("")` / `shellKey("")` prefixes without their key.
const SUBAGENT: &str = "subagent:";
const SHELL: &str = "shell:";

#[cfg(test)]
mod tests;
