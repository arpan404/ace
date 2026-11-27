// SPDX-License-Identifier: Apache-2.0
//! `HostThreads` (`host-threads.ts:38`): threads the daemon holds for its own processes
//! (ADR 0121). Spade's MCP calls act as the thread's root agent, so what Spade delegates becomes
//! its children. No session is ever made for it, and the engine refuses every command that would
//! run an agent in it (`commands::guest::host_refusal`).

use ace_json::Value;

use crate::approvals::live_ace_call;
use crate::{EngineError, EngineStore, State, ThreadId};

/// One host thread to make (`HostThreadInput`).
#[derive(Debug, Clone)]
pub struct HostThreadInput {
    pub id: ThreadId,
    pub workspace_id: String,
    pub title: String,
    /// Recorded only: a delegation that names no provider takes it, as from any parent.
    pub provider: String,
    /// The ceiling the thread's children are contained by.
    pub access: String,
    pub cwd: String,
    pub host: String,
    /// Which of Spade's host threads: absent for Spade's own, `computer:<bot>` for a bot's.
    pub host_key: Option<String>,
}

/// Threads the daemon holds for its own processes.
#[derive(Debug, Default, Clone, Copy)]
pub struct HostThreads;

impl HostThreads {
    /// Makes the thread unless it exists; returns its root agent, which MCP leases name.
    ///
    /// `create_thread` is the synchronous `createEngineThread` the receipt owns (E5.4e/f): it
    /// writes the permission row, parsed thread, session, queue and transitions in its caller's
    /// transaction. The one empty turn that ended follows here.
    pub fn create<C>(
        &self,
        state: &mut State,
        store: &EngineStore,
        input: &HostThreadInput,
        create_thread: C,
    ) -> Result<Option<String>, EngineError>
    where
        C: FnOnce(&mut State, &EngineStore) -> Result<(), EngineError>,
    {
        if store.get_thread(&input.id)?.is_some() {
            return thread_root_agent(state, store, &input.id);
        }
        let at = store.now();
        store.atomic(|_| create_thread(state, store))?;
        // Announces the root agent, which MCP leases name, and leaves it idle: one empty turn
        // that ended, so the root never reads as starting or, after the silence bound, as stuck.
        let facts = ace_json::parse(
            r#"[{"type":"turn.started","agent":"root","trigger":"restart"},{"type":"turn.ended","agent":"root","outcome":"completed"}]"#,
        )
        .map_err(|error| EngineError::Records(error.to_string()))?;
        let Value::Array(facts) = facts else {
            return Ok(None);
        };
        state.apply_facts(store, &input.id, facts.as_slice(), at)?;
        thread_root_agent(state, store, &input.id)
    }

    /// Brings a host thread's access, the ceiling of everything it delegates, up to date.
    pub fn set_access(
        &self,
        state: &mut State,
        store: &EngineStore,
        id: &str,
        access: &str,
    ) -> Result<(), EngineError> {
        state.permission_hold(store, id, access, store.now())?;
        Ok(())
    }

    /// Brings a host thread's provider, which a delegation naming none takes, up to date.
    pub fn set_provider(
        &self,
        _state: &mut State,
        store: &EngineStore,
        id: &str,
        provider: &str,
    ) -> Result<(), EngineError> {
        if store
            .get_thread(id)?
            .and_then(|text| ace_json::parse(&text).ok())
            .and_then(|row| {
                row.get("provider")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .as_deref()
            == Some(provider)
        {
            return Ok(());
        }
        let events = provider_event(provider);
        let at = store.now();
        store.atomic(|_| store.write_events(id, &events, at))
    }
}

/// `thread.updated` with the provider and an empty execution selection (`ExecutionOptions.parse({})`).
fn provider_event(provider: &str) -> String {
    let mut execution = ace_json::Map::new();
    execution.insert("provider", Value::from(provider));
    execution.insert("options", Value::Object(ace_json::Map::new()));
    let mut event = ace_json::Map::new();
    event.insert("type", Value::from("thread.updated"));
    event.insert("provider", Value::from(provider));
    event.insert("execution", Value::Object(execution));
    ace_json::to_string(&Value::Array(vec![Value::Object(event)].into()))
}

fn thread_root_agent(
    state: &mut State,
    store: &EngineStore,
    id: &str,
) -> Result<Option<String>, EngineError> {
    let row = store
        .get_thread(id)?
        .and_then(|text| ace_json::parse(&text).ok());
    if let Some(root) = row
        .as_ref()
        .and_then(|row| row.get("rootAgentId"))
        .and_then(Value::as_str)
        .map(str::to_owned)
    {
        return Ok(Some(root));
    }
    let snapshot = state.repo.require_state(store, id)?;
    let key = snapshot.borrow().state.root_key.clone();
    let Some(key) = key else {
        return Ok(None);
    };
    let id = snapshot
        .borrow()
        .state
        .agents
        .get(&key)
        .map(|record| record.agent.id.clone());
    Ok(id)
}

/// `openHostInteraction`: a host approval (one mirrored from another machine) raised while one
/// of ace's own tools runs reads on that tool's row.
pub fn open_host_interaction(
    state: &mut State,
    store: &EngineStore,
    thread_id: &str,
    key: &str,
    request: Value,
    raw: Vec<Value>,
    about: Option<&str>,
) -> Result<String, EngineError> {
    let (agent, item) = {
        let snapshot = state.repo.require_state(store, thread_id)?;
        // A resting snapshot keeps its transcript lazy: load the live calls this approval could
        // join before reading them, as the TypeScript's in-memory state always has.
        let mut touched = crate::snapshot::touched::Touched::default();
        touched
            .items
            .extend(snapshot.borrow().state.indexes.live_tools.keys().cloned());
        snapshot.borrow_mut().hydrate(&touched)?;
        let borrowed = snapshot.borrow();
        let agent = about
            .filter(|key| borrowed.state.agents.contains_key(*key))
            .map(str::to_owned)
            .or_else(|| borrowed.state.root_key.clone())
            .unwrap_or_else(|| "root".to_owned());
        let item = if request.get("kind").and_then(Value::as_str) == Some("approval") {
            let tool = request
                .get("target")
                .and_then(|target| target.get("tool"))
                .and_then(Value::as_str);
            live_ace_call(&borrowed.state, &agent, tool)
        } else {
            None
        };
        (agent, item)
    };
    let mut fact = ace_json::Map::new();
    fact.insert("type", Value::from("interaction.opened"));
    fact.insert("agent", Value::from(agent));
    fact.insert("interaction", Value::from(key));
    fact.insert("blocking", Value::Bool(true));
    fact.insert("request", request);
    fact.insert("raw", Value::Array(raw.into()));
    if let Some(item) = item {
        fact.insert("item", Value::from(item));
    }
    let at = store.now();
    state.apply_facts(store, thread_id, &[Value::Object(fact)], at)?;
    let snapshot = state.repo.require_state(store, thread_id)?;
    let interaction = snapshot
        .borrow()
        .state
        .interactions
        .get(key)
        .map(|interaction| interaction.id.clone())
        .ok_or_else(|| EngineError::Records("Host interaction was not admitted".to_owned()))?;
    Ok(interaction)
}

/// `postHostNotice`: a notice on the thread's root agent.
pub fn post_host_notice(
    state: &mut State,
    store: &EngineStore,
    thread_id: &str,
    key: &str,
    text: &str,
    level: &str,
) -> Result<(), EngineError> {
    let agent = {
        let snapshot = state.repo.require_state(store, thread_id)?;
        snapshot
            .borrow()
            .state
            .root_key
            .clone()
            .unwrap_or_else(|| "root".to_owned())
    };
    let mut draft = ace_json::Map::new();
    draft.insert("type", Value::from("notice"));
    draft.insert("level", Value::from(level));
    draft.insert("text", Value::from(text));
    draft.insert("complete", Value::Bool(true));
    let mut fact = ace_json::Map::new();
    fact.insert("type", Value::from("item.upsert"));
    fact.insert("agent", Value::from(agent));
    fact.insert("item", Value::from(key));
    fact.insert("draft", Value::Object(draft));
    let at = store.now();
    state.apply_facts(store, thread_id, &[Value::Object(fact)], at)
}

#[cfg(test)]
mod tests {
    //! `guest-admission.process.test.ts` seeds through `engine.guests.create`; these pin the host
    //! thread's creation turn, its access and provider updates, the mirrored approval's row and a
    //! notice, on a real engine rather than the probe.

    use super::*;
    use crate::actor::ActorDeps;
    use crate::executor::{Notified, Notifier};
    use crate::frames::live::UnportedLive;
    use crate::repository::testsupport::{Shell, header, home};
    use crate::{Engine, EngineError, Inputs};
    use std::rc::Rc;

    struct ManualPump;

    impl Notifier for ManualPump {
        fn notify(&self) -> Notified {
            Notified::Posted
        }
    }

    fn engine(name: &str) -> Engine {
        let conn = home(name, &header(name));
        let (_, shell) = Shell::store_with_controls(&conn);
        Engine::new(
            shell.clone(),
            shell,
            Inputs::default(),
            "[]",
            Box::new(ManualPump),
            &conn,
            Rc::new(ActorDeps::production(Rc::new(UnportedLive), 0.0)),
        )
        .expect("the test engine constructs")
    }

    fn with<R>(
        engine: &Engine,
        run: impl FnOnce(&mut State, &EngineStore) -> Result<R, EngineError>,
    ) -> R {
        let core = engine.core().clone();
        core.with_state(|state| {
            // E5.5, E5.6 and E5.9's collaborators are not in this branch yet; the probe answers
            // those. Attribution reads the engine and the embedded catalog, never the probe.
            state.repo.probe_passthrough = true;
            run(state, &core.store)
        })
        .expect("the engine's state")
        .expect("the host call")
    }

    #[test]
    fn a_host_thread_is_created_once_and_leaves_one_ended_turn() {
        let engine = engine("other");
        let input = HostThreadInput {
            id: "host".to_owned(),
            workspace_id: "workspace".to_owned(),
            title: "Spade".to_owned(),
            provider: "claude".to_owned(),
            access: "read-only".to_owned(),
            cwd: "/tmp".to_owned(),
            host: "spade".to_owned(),
            host_key: None,
        };
        let mut created = 0u32;
        with(&engine, |state, store| {
            let root = HostThreads.create(state, store, &input, |state, store| {
                created += 1;
                let header = header("host").replace('\'', "''");
                store.conn().exec(&format!(
                    "INSERT INTO threads (id, workspace_id, title, provider, status, created_at, updated_at) VALUES ('host','workspace','Spade','claude','{{\"state\":\"new\"}}',0,0);
                     INSERT INTO thread_state VALUES ('host','{header}',0);"
                ))?;
                state.permission_ensure(store, "host")?;
                Ok(())
            })?;
            assert!(
                root.is_some(),
                "the root agent is announced by the empty turn"
            );
            // A second create returns the existing root agent without running creation again.
            let again = HostThreads.create(state, store, &input, |_, _| {
                created += 1;
                Ok(())
            })?;
            assert_eq!(again, root);
            let snapshot = state.repo.require_state(store, "host")?;
            let borrowed = snapshot.borrow();
            assert_eq!(borrowed.state.agents.len(), 1);
            let root = borrowed.state.root_key.clone().expect("root key");
            assert!(borrowed.state.agents.contains_key(&root));
            let run = borrowed.state.runs.values().next().expect("a run");
            assert_ne!(run.state, "active");
            Ok(())
        });
        assert_eq!(created, 1);
    }

    #[test]
    fn a_host_threads_ceiling_and_provider_follow_its_owner() {
        let engine = engine("host2");
        with(&engine, |state, store| {
            state.permission_ensure(store, "host2")?;
            HostThreads.set_access(state, store, "host2", "ask")?;
            let permission = state.permission_state(store, "host2")?;
            assert_eq!(permission.effective.as_deref(), Some("ask"));
            assert!(!permission.pending);
            HostThreads.set_provider(state, store, "host2", "codex")?;
            Ok(())
        });
        // The event is the change: the recorded provider and an empty execution selection.
        assert_eq!(
            provider_event("codex"),
            "[{\"type\":\"thread.updated\",\"provider\":\"codex\",\"execution\":{\"provider\":\"codex\",\"options\":{}}}]"
        );
    }

    #[test]
    fn a_host_approval_raised_during_an_ace_call_reads_on_that_calls_row() {
        let engine = engine("host3");
        with(&engine, |state, store| {
            // A host thread has its session row from `createEngineThread`; the ledger names its
            // binding.
            store.conn().exec("INSERT INTO engine_sessions (thread_id,cwd,native_session_id) VALUES ('host3','/tmp','native-1')")?;
            state.apply_facts(
                store,
                "host3",
                &[
                    ace_json::parse(
                        r#"{"type":"agent.seen","agent":"root","origin":"root","fidelity":"full","native":{"provider":"claude","nativeId":"root"},"cwd":"/tmp"}"#,
                    )
                    .unwrap(),
                    ace_json::parse(
                        r#"{"type":"item.upsert","agent":"root","item":"call","draft":{"type":"tool_call","complete":false,"call":{"kind":"mcp","title":"browser_open","status":"running","detail":{"kind":"mcp","server":"ace","tool":"browser_open","arguments":{}}}}}"#,
                    )
                    .unwrap(),
                ],
                1.0,
            )?;
            let request = ace_json::parse(
                r#"{"kind":"approval","title":"studio: run a command","target":{"tool":"browser_open","access":"execute"},"options":[{"id":"allow_once","label":"Allow once","kind":"allow_once"}]}"#,
            )
            .unwrap();
            let id = open_host_interaction(
                state,
                store,
                "host3",
                "machine-request:studio:1",
                request,
                Vec::new(),
                None,
            )?;
            let snapshot = state.repo.require_state(store, "host3")?;
            let call_id = snapshot
                .borrow_mut()
                .items
                .read("call")?
                .expect("the live ace call")
                .id()
                .to_owned();
            let borrowed = snapshot.borrow();
            let interaction = borrowed
                .state
                .interactions
                .values()
                .find(|interaction| interaction.id == id)
                .expect("interaction");
            assert_eq!(interaction.tool_call_id.as_deref(), Some(call_id.as_str()));
            Ok(())
        });
    }

    #[test]
    fn a_host_notice_lands_on_the_root_agent() {
        let engine = engine("host4");
        with(&engine, |state, store| {
            state.apply_facts(
                store,
                "host4",
                &[ace_json::parse(
                    r#"{"type":"agent.seen","agent":"root","origin":"root","fidelity":"full","native":{"provider":"claude","nativeId":"root"},"cwd":"/tmp"}"#,
                )
                .unwrap()],
                1.0,
            )?;
            post_host_notice(
                state,
                store,
                "host4",
                "notice:1",
                "Machine offline",
                "error",
            )?;
            let snapshot = state.repo.require_state(store, "host4")?;
            let item = snapshot
                .borrow_mut()
                .items
                .read("notice:1")?
                .expect("notice");
            let ace_core::items::Item::Notice { text, level, .. } = item else {
                panic!("a notice item");
            };
            assert_eq!(text.as_str(), "Machine offline");
            assert_eq!(level.as_str(), "error");
            Ok(())
        });
    }
}
