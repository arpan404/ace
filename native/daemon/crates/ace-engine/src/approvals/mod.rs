// SPDX-License-Identifier: Apache-2.0
//! ace's own approvals (`ace-approvals.ts`): the live ace tool call an approval belongs to, the
//! agent that made a call, ancestor containment, and the action attribution a catalog entry
//! gives a call or an approval. The interaction ledger (`interaction-ledger.ts`) is `ledger.rs`.

pub mod ledger;

use ace_core::entity_model::InteractionRequest;
use ace_core::item_model::ToolDetail;
use ace_core::items::Item;
use ace_core::state::ThreadState;
use ace_json::Value;
use std::collections::HashSet;

use crate::repository::collaborators::AccessFacts;
use crate::{Core, EngineError, State};

/// The catalog entry an ace tool call earns (`ApprovalTarget` in `@ace/mcp-server`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AceAction {
    pub tool: String,
    pub origin: Option<String>,
    pub description: Option<String>,
    pub risk_class: Option<String>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub paths: Option<Vec<String>>,
    pub access: String,
    pub input: Option<Value>,
}

impl AceAction {
    /// The approval target in the protocol schema's key order.
    pub fn to_json(&self) -> Value {
        let mut value = ace_json::Map::new();
        value.insert("tool", Value::from(self.tool.as_str()));
        if let Some(origin) = &self.origin {
            value.insert("origin", Value::from(origin.as_str()));
        }
        if let Some(description) = &self.description {
            value.insert("description", Value::from(description.as_str()));
        }
        if let Some(risk) = &self.risk_class {
            value.insert("riskClass", Value::from(risk.as_str()));
        }
        if let Some(command) = &self.command {
            value.insert("command", Value::from(command.as_str()));
        }
        if let Some(cwd) = &self.cwd {
            value.insert("cwd", Value::from(cwd.as_str()));
        }
        if let Some(paths) = &self.paths {
            value.insert(
                "paths",
                Value::Array(
                    paths
                        .iter()
                        .map(|path| Value::from(path.as_str()))
                        .collect::<Vec<_>>()
                        .into(),
                ),
            );
        }
        value.insert("access", Value::from(self.access.as_str()));
        if let Some(input) = &self.input {
            value.insert("input", input.clone());
        }
        Value::Object(value)
    }
}

/// The agent's one in-flight call to ace's own MCP server, preferring the named tool.
pub fn live_ace_call(state: &ThreadState, agent_key: &str, tool: Option<&str>) -> Option<String> {
    let agent_id = &state.agents.get(agent_key)?.agent.id;
    let mut calls: Vec<(String, String)> = Vec::new();
    for key in state.indexes.live_tools.keys() {
        let Some(Item::ToolCall { call, base, .. }) = state.items.get(key) else {
            continue;
        };
        if base.agent_id != *agent_id {
            continue;
        }
        if let ToolDetail::Mcp { server, tool, .. } = &call.detail
            && server == "ace"
        {
            calls.push((key.clone(), tool.clone()));
        }
    }
    if calls.len() == 1 {
        return calls.first().map(|(key, _)| key.clone());
    }
    let named: Vec<&(String, String)> = calls
        .iter()
        .filter(|(_, name)| tool.is_some_and(|tool| tool == name))
        .collect();
    (named.len() == 1).then(|| named[0].0.clone())
}

/// The agent making a live call to ace's `tool` whose arguments `matches`: its key when exactly
/// one local agent is.
pub fn ace_caller(
    state: &ThreadState,
    tool: &str,
    matches: impl Fn(&Value) -> bool,
) -> Option<String> {
    let mut callers: HashSet<String> = HashSet::new();
    for key in state.indexes.live_tools.keys() {
        let Some(Item::ToolCall { call, .. }) = state.items.get(key) else {
            continue;
        };
        let ToolDetail::Mcp {
            server,
            tool: name,
            arguments,
            ..
        } = &call.detail
        else {
            continue;
        };
        if server != "ace" || name != tool {
            continue;
        }
        let arguments = arguments
            .as_ref()
            .map(|raw| raw.to_value())
            .unwrap_or(Value::Null);
        if !matches(&arguments) {
            continue;
        }
        let Some(agent) = state.indexes.agent_keys_by_id.get(&call.agent_id) else {
            continue;
        };
        // Only this machine's agents can have made the call: tab ids repeat across machines.
        if state
            .agents
            .get(agent)
            .is_none_or(|record| record.agent.machine.is_some())
        {
            continue;
        }
        callers.insert(agent.clone());
    }
    (callers.len() == 1).then(|| callers.into_iter().next().unwrap_or_default())
}

/// Whether `agent_id` is `ancestor_id` or one of its descendants in the thread's tree.
pub fn within_agent(state: &ThreadState, agent_id: &str, ancestor_id: &str) -> bool {
    let mut seen = HashSet::new();
    let mut current: Option<String> = Some(agent_id.to_owned());
    while let Some(id) = current {
        if id == ancestor_id {
            return true;
        }
        if !seen.insert(id.clone()) {
            break;
        }
        current = state
            .indexes
            .agent_keys_by_id
            .get(&id)
            .and_then(|key| state.agents.get(key))
            .and_then(|record| record.agent.parent_id.clone());
    }
    false
}

/// `attributeAceAction`: only daemon catalog entries with validated arguments earn ace action
/// metadata, and provider-owned fields can never impersonate daemon risk attribution.
pub fn attribute_ace_action(
    state: &ThreadState,
    fact: Value,
    resolve: &dyn Fn(&str, Option<&Value>) -> Option<AceAction>,
) -> Value {
    if text(&fact, "type") == Some("item.upsert")
        && fact
            .get("draft")
            .and_then(|draft| draft.get("type"))
            .and_then(Value::as_str)
            == Some("tool_call")
    {
        let detail = fact.get("draft").and_then(|draft| draft.get("call"));
        let action = detail
            .and_then(|call| call.get("detail"))
            .filter(|detail| is_ace_mcp(detail))
            .and_then(|detail| {
                let tool = detail
                    .get("tool")
                    .and_then(Value::as_str)
                    .filter(|tool| !tool.is_empty())?;
                resolve(tool, detail.get("arguments"))
            });
        if let Some(action) = action
            && let Some(call) = fact
                .get("draft")
                .and_then(|draft| draft.get("call"))
                .cloned()
        {
            let mut call = call;
            let title = action.description.clone().unwrap_or(action.tool.clone());
            set(&mut call, "title", Value::from(title));
            let mut draft = fact.get("draft").cloned().unwrap_or(Value::Null);
            set(&mut draft, "call", call);
            let mut fact = fact;
            set(&mut fact, "draft", draft);
            return fact;
        }
        return fact;
    }
    if text(&fact, "type") != Some("interaction.opened") {
        return fact;
    }
    let request = fact.get("request").cloned().unwrap_or(Value::Null);
    if text(&request, "kind") != Some("approval") {
        return fact;
    }
    // A provider's own gate on an ace tool call joins that call.
    let ace_server = request
        .get("mcpServer")
        .and_then(|server| server.get("name"))
        .and_then(Value::as_str)
        == Some("ace");
    if fact.get("item").is_none_or(Value::is_null) && ace_server {
        let tool = request
            .get("target")
            .and_then(|target| target.get("tool"))
            .and_then(Value::as_str);
        if let Some(call) = live_ace_call(state, text(&fact, "agent").unwrap_or("root"), tool) {
            let mut joined = fact.clone();
            set(&mut joined, "item", Value::from(call));
            return attribute_ace_action(state, joined, resolve);
        }
    }
    let target = request.get("target");
    let item = fact
        .get("item")
        .and_then(Value::as_str)
        .and_then(|key| state.items.get(key));
    let detail = match item {
        Some(Item::ToolCall { call, .. }) => Some(&call.detail),
        _ => None,
    };
    let action = match target {
        Some(target)
            if target
                .get("tool")
                .and_then(Value::as_str)
                .is_some_and(|tool| tool.starts_with("mcp__ace__"))
                || ace_server =>
        {
            resolve(
                target
                    .get("tool")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                target.get("input"),
            )
        }
        _ => match detail {
            Some(ToolDetail::Mcp {
                server,
                tool,
                arguments,
                ..
            }) if server == "ace" => {
                let input = arguments.as_ref().map(|raw| raw.to_value());
                resolve(tool, input.as_ref())
            }
            _ => None,
        },
    };
    if let Some(action) = action {
        let mut request = request;
        set(&mut request, "target", action.to_json());
        let title = action.description.clone().unwrap_or(action.tool.clone());
        set(&mut request, "title", Value::from(title));
        match &action.description {
            Some(description) => set(
                &mut request,
                "description",
                Value::from(description.as_str()),
            ),
            None => drop_key(&mut request, "description"),
        }
        let mut fact = fact;
        set(&mut fact, "request", request);
        return fact;
    }
    // Provider-owned fields cannot impersonate daemon risk attribution.
    if let Some(target) = target {
        let mut native = target.clone();
        for key in ["origin", "riskClass", "description"] {
            drop_key(&mut native, key);
        }
        let mut request = request;
        set(&mut request, "target", native);
        let mut fact = fact;
        set(&mut fact, "request", request);
        return fact;
    }
    fact
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn is_ace_mcp(detail: &Value) -> bool {
    text(detail, "kind") == Some("mcp") && text(detail, "server") == Some("ace")
}

fn set(object: &mut Value, key: &str, value: Value) {
    if let Some(map) = object.as_object_mut() {
        map.insert(key, value);
    }
}

fn drop_key(object: &mut Value, key: &str) {
    if let Some(map) = object.as_object_mut() {
        map.shift_remove(key);
    }
}

/// `interactions.closed`'s decision: whether the person's choice runs the call and what it
/// becomes.
pub(super) fn closed_outcome(
    state: &ThreadState,
    key: &str,
    native_item: &str,
    event: &Value,
) -> Option<Value> {
    let interaction = state.interactions.get(key)?;
    let Item::ToolCall { call, .. } = state.items.get(native_item)? else {
        return None;
    };
    if !["pending", "running", "awaiting_approval"].contains(&call.status.as_str()) {
        return None;
    }
    let execution = matches!(interaction.request, InteractionRequest::Approval { .. })
        && call.kind != "ask_user";
    let resolution = event
        .get("resolution")
        .filter(|resolution| text(resolution, "kind") == Some("approval"));
    let decision = match (&interaction.request, resolution) {
        (InteractionRequest::Approval { options, .. }, Some(resolution))
            if execution && text(resolution, "kind") == Some("approval") =>
        {
            let option_id = text(resolution, "optionId")?;
            options
                .iter()
                .find(|option| option.id == option_id)
                .and_then(|option| option.kind.clone())
        }
        _ => None,
    };
    // A neutral choice ("Ask later") neither starts nor refuses the call: the agent settles it.
    if decision.as_deref() == Some("other") {
        return None;
    }
    let declined = matches!(decision.as_deref(), Some("deny" | "deny_always"));
    let cancelled = decision.as_deref() == Some("cancel");
    let state_name = text(event, "state").unwrap_or_default();
    let allowed = execution && state_name == "resolved" && !declined && !cancelled;
    let status = if allowed {
        "running"
    } else if declined {
        "declined"
    } else if state_name == "resolved" && !cancelled {
        "succeeded"
    } else {
        "cancelled"
    };
    let agent = state
        .indexes
        .agent_keys_by_id
        .get(&call.agent_id)
        .cloned()
        .or_else(|| state.root_key.clone())
        .unwrap_or_else(|| "root".to_owned());
    let mut call_out = ace_json::Map::new();
    call_out.insert("status", Value::from(status));
    if !allowed && let Some(closed_at) = event.get("closedAt").cloned() {
        call_out.insert("endedAt", closed_at);
    }
    let mut draft = ace_json::Map::new();
    draft.insert("type", Value::from("tool_call"));
    draft.insert("complete", Value::Bool(!allowed));
    draft.insert("call", Value::Object(call_out));
    let mut fact = ace_json::Map::new();
    fact.insert("type", Value::from("item.upsert"));
    fact.insert("agent", Value::from(agent));
    fact.insert("item", Value::from(native_item));
    fact.insert("draft", Value::Object(draft));
    Some(Value::Object(fact))
}

impl State {
    fn approval_core(&self) -> Result<Option<std::rc::Rc<Core>>, EngineError> {
        if let Some(core) = self.engine.upgrade() {
            return Ok(Some(core));
        }
        if self.repo.probe_passthrough {
            return Ok(None);
        }
        Err(EngineError::not_ported("the engine's store", "E5.7"))
    }
}

impl AccessFacts for State {
    /// `permissions.effective`: the root turn's permission mode.
    fn permissions_effective(&mut self, thread: &str) -> Result<Option<String>, EngineError> {
        let Some(core) = self.approval_core()? else {
            return Ok(None);
        };
        self.permission_effective(&core.store, thread)
    }

    /// `interactions.obsolete`: whether the fact is for an interaction ace already settled.
    fn interactions_obsolete(&mut self, thread: &str, fact: &Value) -> Result<bool, EngineError> {
        let Some(core) = self.approval_core()? else {
            return Ok(false);
        };
        ledger::obsolete(&core.store, thread, fact)
    }

    /// `interactions.opened`.
    fn interactions_opened(
        &mut self,
        thread: &str,
        fact: &Value,
        generation: Option<f64>,
    ) -> Result<(), EngineError> {
        let Some(core) = self.approval_core()? else {
            return Ok(());
        };
        let snapshot = self.repo.require_state(&core.store, thread)?;
        ledger::opened(&core.store, &snapshot.borrow().state, fact, generation)
    }

    /// `interactions.closed`: the facts a settled interaction emits.
    fn interactions_closed(&mut self, event: &Value) -> Result<Vec<Value>, EngineError> {
        let Some(core) = self.approval_core()? else {
            return Ok(Vec::new());
        };
        let Some(thread) = ledger::event_thread(&core.store, event)? else {
            return Ok(Vec::new());
        };
        let Some(snapshot) = self.repo.state(&core.store, &thread)? else {
            return Ok(Vec::new());
        };
        let facts = ledger::closed(&core.store, &mut snapshot.borrow_mut().state, event)?;
        Ok(facts)
    }

    /// `interactions.observe`.
    fn interactions_observe(&mut self, thread: &str, events: &[Value]) -> Result<(), EngineError> {
        let Some(core) = self.approval_core()? else {
            return Ok(());
        };
        ledger::observe(&core.store, thread, events)
    }

    /// `attributeAceAction`: the binding supplies the catalog entry (`options.aceToolAction`).
    fn attribute_ace_action(&mut self, _thread: &str, fact: Value) -> Result<Value, EngineError> {
        // The pure port is `attribute_ace_action` above; the binding that owns the
        // `aceToolAction` object port calls it. Until that port is bound the frame must fail
        // rather than silently drop ace's attribution.
        if self.repo.probe_passthrough {
            return Ok(fact);
        }
        Err(EngineError::not_ported(
            "an ace action's attribution",
            "E5.7",
        ))
    }
}

#[cfg(test)]
mod tests {
    //! `ace-approvals.test.ts`: browser help a subagent asks for is that subagent's; the main agent's
    //! stays its own; two callers about one tab (or none) guess nobody; a child on another
    //! machine is never the local caller; an agent's turn reaches its descendants, never a
    //! sibling's. `ace-approvals.process.test.ts`: an ace tool call carries the catalog action; a
    //! provider's gate on a destructive ace tool joins that call; foreign tools and invalid
    //! arguments never read as ace's own.

    use super::*;
    use ace_core::reduce::apply;
    use ace_core::state::{ApplyContext, CoreConfig, IdSource, create_thread_state};

    struct Ids(u64);
    impl IdSource for Ids {
        fn next(&mut self, kind: &str) -> Option<String> {
            self.0 += 1;
            Some(format!("{kind}-{}", self.0))
        }
    }

    fn thread(facts: &[Value]) -> ThreadState {
        let config = CoreConfig {
            provider: "claude".to_owned(),
            silence_ms: 90_000.0,
            liveness: None,
        };
        let mut state = create_thread_state("thread-help".to_owned(), None, config).expect("state");
        let mut ids = Ids(0);
        for fact in facts {
            let mut events = Vec::new();
            apply(
                &mut state,
                fact,
                &mut ApplyContext {
                    now: 100,
                    ids: &mut ids,
                    resolving_interactions: None,
                },
                &mut events,
            );
        }
        state
    }

    fn root() -> Value {
        ace_json::parse(
            r#"{"type":"agent.seen","agent":"root","origin":"root","fidelity":"full","native":{"provider":"claude","nativeId":"root"},"cwd":"/tmp"}"#,
        )
        .unwrap()
    }

    fn worker() -> Value {
        ace_json::parse(
            r#"{"type":"agent.seen","agent":"worker","parent":"root","spawnedBy":"root","origin":"provider_subagent","fidelity":"full","native":{"provider":"claude","nativeId":"worker"},"cwd":"/tmp","name":"Worker"}"#,
        )
        .unwrap()
    }

    fn help_call(agent: &str, item: &str, tab: &str) -> Value {
        ace_json::parse(&format!(
            r#"{{"type":"item.upsert","agent":"{agent}","item":"{item}","draft":{{"type":"tool_call","complete":false,"call":{{"kind":"mcp","title":"browser_request_help","status":"running","detail":{{"kind":"mcp","server":"ace","tool":"browser_request_help","arguments":{{"tabId":"{tab}"}}}}}}}}}}"#
        ))
        .unwrap()
    }

    fn for_tab(tab: &str) -> impl Fn(&Value) -> bool + '_ {
        move |args: &Value| args.get("tabId").and_then(Value::as_str) == Some(tab)
    }

    #[test]
    fn browser_help_a_subagent_asks_for_is_that_subagents() {
        let state = thread(&[root(), worker(), help_call("worker", "call-1", "tab-1")]);
        assert_eq!(
            ace_caller(&state, "browser_request_help", for_tab("tab-1")).as_deref(),
            Some("worker")
        );
    }

    #[test]
    fn browser_help_the_main_agent_asks_for_stays_the_main_agents() {
        let state = thread(&[root(), worker(), help_call("root", "call-1", "tab-1")]);
        assert_eq!(
            ace_caller(&state, "browser_request_help", for_tab("tab-1")).as_deref(),
            Some("root")
        );
    }

    #[test]
    fn when_two_agents_ask_about_the_same_tab_or_none_is_calling_nobody_is_guessed() {
        let both = thread(&[
            root(),
            worker(),
            help_call("root", "call-1", "tab-1"),
            help_call("worker", "call-2", "tab-1"),
        ]);
        assert_eq!(
            ace_caller(&both, "browser_request_help", for_tab("tab-1")),
            None
        );
        assert_eq!(
            ace_caller(
                &thread(&[root(), worker()]),
                "browser_request_help",
                for_tab("tab-1")
            ),
            None
        );
        let other = thread(&[root(), worker(), help_call("worker", "call-1", "tab-2")]);
        assert_eq!(
            ace_caller(&other, "browser_request_help", for_tab("tab-1")),
            None
        );
    }

    #[test]
    fn a_child_on_another_machine_asking_about_the_same_tab_id_is_never_taken_for_the_local_caller()
    {
        let remote = ace_json::parse(
            r#"{"type":"agent.seen","agent":"studio-child","parent":"root","spawnedBy":"root","origin":"provider_subagent","fidelity":"full","native":{"provider":"claude","nativeId":"studio-child"},"cwd":"/tmp","name":"Studio child","machine":{"machine":"studio","name":"Studio"}}"#,
        )
        .unwrap();
        let state = thread(&[
            root(),
            remote.clone(),
            help_call("studio-child", "call-1", "tab-1"),
        ]);
        assert_eq!(
            ace_caller(&state, "browser_request_help", for_tab("tab-1")),
            None
        );
        let both = thread(&[
            root(),
            remote.clone(),
            worker(),
            help_call("studio-child", "call-1", "tab-1"),
            help_call("worker", "call-2", "tab-1"),
        ]);
        assert_eq!(
            ace_caller(&both, "browser_request_help", for_tab("tab-1")).as_deref(),
            Some("worker")
        );
    }

    #[test]
    fn an_agents_turn_reaches_only_its_own_requests_and_descendants_never_a_siblings() {
        let helper = ace_json::parse(
            r#"{"type":"agent.seen","agent":"helper","parent":"worker","spawnedBy":"worker","origin":"provider_subagent","fidelity":"full","native":{"provider":"claude","nativeId":"helper"},"cwd":"/tmp","name":"Helper"}"#,
        )
        .unwrap();
        let other = ace_json::parse(
            r#"{"type":"agent.seen","agent":"other","parent":"root","spawnedBy":"root","origin":"provider_subagent","fidelity":"full","native":{"provider":"claude","nativeId":"other"},"cwd":"/tmp","name":"Other"}"#,
        )
        .unwrap();
        let state = thread(&[root(), worker(), helper, other]);
        let id = |key: &str| {
            state
                .agents
                .get(key)
                .map(|record| record.agent.id.clone())
                .unwrap_or_default()
        };
        assert!(within_agent(&state, &id("worker"), &id("worker")));
        assert!(within_agent(&state, &id("helper"), &id("worker")));
        assert!(within_agent(&state, &id("helper"), &id("root")));
        assert!(!within_agent(&state, &id("other"), &id("worker")));
        assert!(!within_agent(&state, &id("root"), &id("worker")));
    }

    fn action(tool: &str) -> AceAction {
        AceAction {
            tool: tool.to_owned(),
            origin: Some("ace".to_owned()),
            description: Some("Read a thread".to_owned()),
            risk_class: Some("read-only".to_owned()),
            access: "read".to_owned(),
            ..AceAction::default()
        }
    }

    #[test]
    fn a_catalog_entry_titles_an_ace_tool_call_and_a_provider_gate_joins_that_call() {
        let state = thread(&[root(), help_call("root", "call", "tab-1")]);
        let tool = ace_json::parse(
            r#"{"type":"item.upsert","agent":"root","item":"call","draft":{"type":"tool_call","call":{"title":"thread_read","detail":{"kind":"mcp","server":"ace","tool":"thread_read","arguments":{"threadId":"child"}}}}}"#,
        )
        .unwrap();
        let resolve = |name: &str, _input: Option<&Value>| Some(action(name));
        let attributed = attribute_ace_action(&state, tool, &resolve);
        assert_eq!(
            attributed
                .get("draft")
                .and_then(|draft| draft.get("call"))
                .and_then(|call| call.get("title"))
                .and_then(Value::as_str),
            Some("Read a thread")
        );

        // A gate with no item names ace's server: it reads on the live call's row.
        let gate = ace_json::parse(
            r#"{"type":"interaction.opened","agent":"root","interaction":"gate","request":{"kind":"approval","title":"browser_request_help","target":{"tool":"browser_request_help"},"mcpServer":{"name":"ace","source":"codex"},"options":[]}}"#,
        )
        .unwrap();
        let joined = attribute_ace_action(&state, gate, &resolve);
        assert_eq!(joined.get("item").and_then(Value::as_str), Some("call"));
        assert_eq!(
            text(&joined.get("request").cloned().unwrap(), "title"),
            Some("Read a thread")
        );
        let target = joined
            .get("request")
            .and_then(|request| request.get("target"))
            .expect("target");
        assert_eq!(text(target, "origin"), Some("ace"));
        assert_eq!(text(target, "riskClass"), Some("read-only"));
    }

    #[test]
    fn a_foreign_server_or_invalid_arguments_never_read_as_aces_own_action() {
        let state = thread(&[root()]);
        for (server, input) in [
            ("foreign", "{\"threadId\":\"child\"}"),
            ("ace", "{\"threadId\":\"child\",\"execute\":\"rm\"}"),
        ] {
            let fact = ace_json::parse(&format!(
                r#"{{"type":"interaction.opened","agent":"root","interaction":"a","request":{{"kind":"approval","title":"Unknown","target":{{"tool":"thread_read","access":"unknown","origin":"provider","riskClass":"external-effect","description":"from the provider","input":{input}}},"options":[]}}}}"#
            ))
            .unwrap();
            let resolve = |_name: &str, _input: Option<&Value>| {
                // The catalog refuses invalid arguments: no action.
                if server == "ace" {
                    None
                } else {
                    Some(action("thread_read"))
                }
            };
            let attributed = attribute_ace_action(&state, fact, &resolve);
            let target = attributed
                .get("request")
                .and_then(|request| request.get("target"))
                .expect("target");
            assert_ne!(text(target, "origin"), Some("ace"));
            assert_eq!(text(target, "riskClass"), None);
            assert_eq!(text(target, "description"), None);
        }
    }

    #[test]
    fn a_settled_execution_permission_moves_its_tool_call_to_running_then_the_result_settles_it() {
        let state = thread(&[
            root(),
            ace_json::parse(
                r#"{"type":"item.upsert","agent":"root","item":"execution","draft":{"type":"tool_call","complete":false,"call":{"kind":"shell","title":"Offline","status":"awaiting_approval","detail":{"kind":"shell","command":"offline"}}}}"#,
            )
            .unwrap(),
            ace_json::parse(
                r#"{"type":"interaction.opened","agent":"root","interaction":"approval","item":"execution","blocking":true,"request":{"kind":"approval","title":"Run?","options":[{"id":"decision","label":"Decide","kind":"allow_once"}]}}"#,
            )
            .unwrap(),
        ]);
        let event = ace_json::parse(
            r#"{"type":"interaction.closed","interactionId":"approval","state":"resolved","closedAt":200,"resolution":{"kind":"approval","optionId":"decision"}}"#,
        )
        .unwrap();
        let interaction_id = state
            .interactions
            .get("approval")
            .map(|interaction| interaction.id.clone())
            .expect("interaction");
        let _ = interaction_id;
        let facts = closed_outcome(&state, "approval", "execution", &event).expect("fact");
        assert_eq!(
            facts
                .get("draft")
                .and_then(|draft| draft.get("call"))
                .and_then(|call| call.get("status"))
                .and_then(Value::as_str),
            Some("running")
        );
        assert_eq!(
            facts
                .get("draft")
                .and_then(|draft| draft.get("complete"))
                .and_then(Value::as_bool),
            Some(false)
        );
    }
}
