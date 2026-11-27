// SPDX-License-Identifier: Apache-2.0
//! `GuestThreads` (`guest-threads.ts:21`): threads that hold remote tool use from agents on other
//! machines (ADR 0105). They are made without a provider adapter, so a machine with no CLI can
//! host them, and they show work only through background rows the host adds and ends.

use crate::{EngineError, EngineStore, State, ThreadId};
use ace_core::items::Item;
use ace_json::Value;

/// The machine and name a guest thread serves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuestInfo {
    pub host: String,
    pub name: String,
}

/// One guest thread to make (`GuestThreadInput`).
#[derive(Debug, Clone)]
pub struct GuestThreadInput {
    pub id: ThreadId,
    pub workspace_id: String,
    pub title: String,
    /// Recorded only: a guest thread never launches its provider.
    pub provider: String,
    pub cwd: String,
    pub guest: GuestInfo,
}

/// A background row to add, or one to end (`hold`'s union).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GuestHold {
    Start { title: String },
    End { status: String },
}

/// Threads that hold remote tool use from agents on other machines.
pub struct GuestThreads {
    wake: Box<dyn Fn(&str)>,
}

impl Default for GuestThreads {
    fn default() -> GuestThreads {
        GuestThreads {
            wake: Box::new(|_| {}),
        }
    }
}

impl GuestThreads {
    pub fn new(wake: Box<dyn Fn(&str)>) -> GuestThreads {
        GuestThreads { wake }
    }

    /// Makes the thread unless it exists.
    pub fn create<C>(
        &self,
        state: &mut State,
        store: &EngineStore,
        input: &GuestThreadInput,
        create_thread: C,
    ) -> Result<(), EngineError>
    where
        C: FnOnce(&mut State, &EngineStore) -> Result<(), EngineError>,
    {
        if store.get_thread(&input.id)?.is_some() {
            return Ok(());
        }
        store.atomic(|_| create_thread(state, store))
    }

    /// Adds or ends a stoppable background row on the thread's root agent. While one runs the
    /// thread reads as waiting, never done; a stop is routed by `bindExternalTaskStop`.
    pub fn hold(
        &self,
        state: &mut State,
        store: &EngineStore,
        thread_id: &str,
        task: &str,
        hold: &GuestHold,
    ) -> Result<(), EngineError> {
        let agent = guest_agent(state, store, thread_id)?;
        let at = store.now();
        let fact = match hold {
            GuestHold::Start { title } => {
                let mut fact = ace_json::Map::new();
                fact.insert("type", Value::from("background.started"));
                fact.insert("owner", Value::from("ace"));
                fact.insert("agent", Value::from(agent));
                fact.insert("task", Value::from(task));
                fact.insert("kind", Value::from("other"));
                fact.insert("title", Value::from(title.as_str()));
                fact.insert("stoppable", Value::Bool(true));
                Value::Object(fact)
            }
            GuestHold::End { status } => {
                let mut fact = ace_json::Map::new();
                fact.insert("type", Value::from("background.ended"));
                fact.insert("task", Value::from(task));
                fact.insert("status", Value::from(status.as_str()));
                Value::Object(fact)
            }
        };
        let ended = matches!(hold, GuestHold::End { .. });
        state.apply_facts(store, thread_id, &[fact], at)?;
        if ended {
            (self.wake)(thread_id);
        }
        Ok(())
    }

    /// A command an agent on another machine ran here, as a shell call in the transcript: its
    /// command line and working directory when it starts, its exit code when it ends.
    pub fn command(
        &self,
        state: &mut State,
        store: &EngineStore,
        thread_id: &str,
        key: &str,
        entry: GuestCommand<'_>,
    ) -> Result<(), EngineError> {
        let agent = guest_agent(state, store, thread_id)?;
        let mut detail = ace_json::Map::new();
        detail.insert("kind", Value::from("shell"));
        detail.insert("command", Value::from(entry.command));
        detail.insert("cwd", Value::from(entry.cwd));
        if let Some(exit) = entry.exit_code {
            detail.insert("exitCode", exit.map_or(Value::Null, Value::from));
        }
        let mut call = ace_json::Map::new();
        call.insert("kind", Value::from("shell"));
        call.insert("title", Value::from(utf16_prefix(entry.command, 200)));
        call.insert("status", Value::from(entry.status));
        call.insert("detail", Value::Object(detail));
        call.insert("startedAt", Value::from(entry.started_at));
        if let Some(ended) = entry.ended_at {
            call.insert("endedAt", Value::from(ended));
        }
        call.insert("raw", Value::Array(Vec::new().into()));
        let mut draft = ace_json::Map::new();
        draft.insert("type", Value::from("tool_call"));
        draft.insert("call", Value::Object(call));
        let mut fact = ace_json::Map::new();
        fact.insert("type", Value::from("item.upsert"));
        fact.insert("agent", Value::from(agent));
        fact.insert("item", Value::from(key));
        fact.insert("draft", Value::Object(draft));
        let at = store.now();
        state.apply_facts(store, thread_id, &[Value::Object(fact)], at)
    }

    /// Ends shell calls whose key starts with `prefix` that still read running: their process
    /// ended with the daemon that started them. Each is marked cancelled, ending now.
    pub fn end_commands(
        &self,
        state: &mut State,
        store: &EngineStore,
        thread_id: &str,
        prefix: &str,
    ) -> Result<usize, EngineError> {
        let at = store.now();
        let facts = {
            let Some(snapshot) = state.repo.state(store, thread_id)? else {
                return Ok(0);
            };
            // The transcript is lazy at rest: load only the keys this prefix names.
            let mut touched = crate::snapshot::touched::Touched::default();
            touched.items.extend(
                snapshot
                    .borrow_mut()
                    .items
                    .keys()?
                    .into_iter()
                    .filter(|key| key.starts_with(prefix)),
            );
            snapshot.borrow_mut().hydrate(&touched)?;
            let borrowed = snapshot.borrow();
            let Some(agent) = borrowed.state.root_key.clone() else {
                return Ok(0);
            };
            let facts: Vec<Value> = borrowed
                .state
                .items
                .iter()
                .filter_map(|(key, item)| {
                    let Item::ToolCall { call, .. } = item else {
                        return None;
                    };
                    if !key.starts_with(prefix) || call.status != "running" {
                        return None;
                    }
                    let mut call = ace_json::Map::new();
                    call.insert("status", Value::from("cancelled"));
                    call.insert("endedAt", Value::from(at));
                    let mut draft = ace_json::Map::new();
                    draft.insert("type", Value::from("tool_call"));
                    draft.insert("call", Value::Object(call));
                    let mut fact = ace_json::Map::new();
                    fact.insert("type", Value::from("item.upsert"));
                    fact.insert("agent", Value::from(agent.as_str()));
                    fact.insert("item", Value::from(key.as_str()));
                    fact.insert("draft", Value::Object(draft));
                    Some(Value::Object(fact))
                })
                .collect();
            facts
        };
        if facts.is_empty() {
            return Ok(0);
        }
        let count = facts.len();
        state.apply_facts(store, thread_id, &facts, at)?;
        (self.wake)(thread_id);
        Ok(count)
    }

    /// Background rows still running whose key starts with `prefix`.
    pub fn running(
        &self,
        state: &mut State,
        store: &EngineStore,
        thread_id: &str,
        prefix: &str,
    ) -> Result<Vec<String>, EngineError> {
        let Some(snapshot) = state.repo.state(store, thread_id)? else {
            return Ok(Vec::new());
        };
        let borrowed = snapshot.borrow();
        Ok(borrowed
            .state
            .tasks
            .iter()
            .filter(|(key, task)| key.starts_with(prefix) && task.status == "running")
            .map(|(key, _)| key.clone())
            .collect())
    }
}

/// The shell call a guest's agent ran (`command`'s entry).
#[derive(Debug, Clone, Copy)]
pub struct GuestCommand<'a> {
    pub command: &'a str,
    pub cwd: &'a str,
    pub status: &'a str,
    /// `Some(None)` is a recorded null exit code; `None` is no exit code yet.
    pub exit_code: Option<Option<i64>>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

fn guest_agent(
    state: &mut State,
    store: &EngineStore,
    thread_id: &str,
) -> Result<String, EngineError> {
    let snapshot = state.repo.require_state(store, thread_id)?;
    snapshot
        .borrow()
        .state
        .root_key
        .clone()
        .ok_or_else(|| EngineError::Records("Guest thread has no root agent yet".to_owned()))
}

/// JavaScript's `String#slice(0, 200)` counts UTF-16 units (rule 17): keep whole scalars until
/// the next one would cross the bound.
fn utf16_prefix(text: &str, max: usize) -> &str {
    let mut units = 0usize;
    for (index, character) in text.char_indices() {
        let width = character.len_utf16();
        if units + width > max {
            return &text[..index];
        }
        units += width;
    }
    text
}

#[cfg(test)]
mod tests {
    //! `guest-admission.process.test.ts` seeds through `engine.guests.create`; these pin the
    //! creation, a stopped command row and the bounded title JavaScript's `slice(0, 200)` gives.

    use super::*;
    use crate::repository::testsupport::{Shell, header, home};

    fn setup(name: &str) -> (std::sync::Arc<ace_store::Connection>, EngineStore, State) {
        let conn = home(name, &header(name));
        let store = Shell::store(&conn);
        let mut state = State::default();
        // These cases fold facts on a bare state, where the probe's pass-through answers the
        // collaborators an engine would.
        state.repo.probe_passthrough = true;
        (conn, store, state)
    }

    fn seed_root(state: &mut State, store: &EngineStore, thread: &str) {
        state
            .apply_facts(
                store,
                thread,
                &[ace_json::parse(
                    r#"{"type":"agent.seen","agent":"root","origin":"root","fidelity":"full","native":{"provider":"codex","nativeId":"root"},"cwd":"/tmp"}"#,
                )
                .unwrap()],
                0.0,
            )
            .expect("root");
    }

    #[test]
    fn a_guest_thread_is_created_through_the_injected_creation_step() {
        let (_conn, store, mut state) = setup("guest");
        let input = GuestThreadInput {
            id: "guest".to_owned(),
            workspace_id: "workspace".to_owned(),
            title: "Linux box · Fix the login flow".to_owned(),
            provider: "codex".to_owned(),
            cwd: "/tmp".to_owned(),
            guest: GuestInfo {
                host: "linux-box".to_owned(),
                name: "Linux box".to_owned(),
            },
        };
        let mut created = 0u32;
        GuestThreads::default()
            .create(&mut state, &store, &input, |state, store| {
                created += 1;
                state.permission_ensure(store, "guest")?;
                Ok(())
            })
            .expect("create");
        assert_eq!(created, 1);
        assert!(state.permission_state(&store, "guest").is_ok());
    }

    #[test]
    fn a_stopped_command_ends_running_shell_calls_and_wakes_the_thread() {
        let (_conn, store, mut state) = setup("guest2");
        seed_root(&mut state, &store, "guest2");
        let woke = std::rc::Rc::new(std::cell::Cell::new(0u32));
        let counter = std::rc::Rc::clone(&woke);
        let guests = GuestThreads::new(Box::new(move |_| counter.set(counter.get() + 1)));
        guests
            .command(
                &mut state,
                &store,
                "guest2",
                "remote:1",
                GuestCommand {
                    command: "echo hi",
                    cwd: "/tmp",
                    status: "running",
                    exit_code: None,
                    started_at: 1,
                    ended_at: None,
                },
            )
            .expect("command");
        let ended = guests
            .end_commands(&mut state, &store, "guest2", "remote:")
            .expect("end");
        assert_eq!(ended, 1);
        assert_eq!(woke.get(), 1);
    }

    #[test]
    fn a_guest_commands_title_counts_utf16_units_like_javascript_slice() {
        // 100 astral characters are 200 UTF-16 units: they fit exactly.
        let text = "😀".repeat(150);
        assert_eq!(utf16_prefix(&text, 200).encode_utf16().count(), 200);
        assert_eq!(utf16_prefix(&text, 200).chars().count(), 100);
        // A boundary inside a surrogate pair keeps the whole scalar.
        let mixed = format!("a{}", "😀".repeat(150));
        assert_eq!(utf16_prefix(&mixed, 2), "a");
        assert_eq!(utf16_prefix("short", 200), "short");
    }
}
