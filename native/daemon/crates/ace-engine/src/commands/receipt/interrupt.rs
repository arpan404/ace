// SPDX-License-Identifier: Apache-2.0
//! `thread.interrupt`'s checks (`handler.ts:417`-`:451`, E5.4e): which agent, which run, how far
//! the sender had seen, and whether the adapter can stop that agent at all.

use ace_json::Value;

use crate::commands::error;
use crate::{Core, EngineError, State};

/// The interrupt's refusals, in the TypeScript's order; `Some` is the committed refusal.
pub(super) fn check(
    core: &Core,
    state: &mut State,
    p: &Value,
    thread: &str,
    id: &str,
) -> Result<Option<Value>, EngineError> {
    let fail = |code: &str| error(id, code);
    let agent = p.get("agentId").and_then(Value::as_str).map(str::to_owned);
    let run_id = p.get("runId").and_then(Value::as_str).map(str::to_owned);
    let snapshot = state.repo.require_state(&core.store, thread)?;
    let (known, root_id, target, run, run_state) = {
        let borrowed = snapshot.borrow();
        // `runId` names a **state** key (`state.agents[target]`, `handler.ts:432`-`:441`);
        // `agentId` names an agent id, which the index maps to its key.
        let root_key = borrowed.state.root_key.clone();
        let root_id = borrowed.root_agent_id();
        let known = agent.as_deref().is_none_or(|agent| {
            borrowed
                .state
                .agents
                .values()
                .any(|record| record.agent.id == agent)
        });
        let target = match agent.as_deref() {
            None => root_key,
            Some(agent) => borrowed.state.indexes.agent_keys_by_id.get(agent).cloned(),
        };
        let active = target
            .as_ref()
            .and_then(|key| borrowed.state.agents.get(key))
            .and_then(|record| record.active_run.clone());
        let run_state = run_id
            .as_deref()
            .and_then(|run| borrowed.state.runs.get(run))
            .map(|run| run.state.clone());
        (known, root_id, target, active, run_state)
    };
    if !known {
        return Ok(Some(fail("agent_not_found")));
    }
    if let Some(before) = p.get("beforeSeq").and_then(Value::as_i64) {
        // The SQL's agent id: the named agent, else the root record's own id.
        let target = agent.as_deref().or(root_id.as_deref()).unwrap_or_default();
        let sql = "SELECT 1 FROM events WHERE thread_id=? AND seq>? AND (
          (type='run.started' AND json_extract(payload,'$.run.agentId')=?) OR
          (type='item.created' AND json_extract(payload,'$.item.agentId')=? AND json_extract(payload,'$.item.role')='user' AND COALESCE(json_extract(payload,'$.item.synthetic'),0)=0)
        ) LIMIT 1";
        let row = ace_store::stmt_cache::get_row(
            core.store.conn(),
            sql,
            vec![
                ace_store::Value::Text(thread.to_owned()),
                ace_store::Value::Integer(before),
                ace_store::Value::Text(target.to_owned()),
                ace_store::Value::Text(target.to_owned()),
            ],
        )?;
        if row.is_none() {
            return Ok(Some(fail("stale_interrupt")));
        }
    }
    if let Some(run_id) = run_id.as_deref()
        && (target.is_none()
            || run.as_deref() != Some(run_id)
            || run_state.as_deref() != Some("active"))
    {
        return Ok(Some(fail("stale_interrupt")));
    }
    // `handler.ts:443`-`:451`: an adapter that cannot control its children read-only stops only
    // the root; a Stop of one of its children is refused.
    if let Some(agent_id) = agent.as_deref() {
        let provider = snapshot.borrow().state.config.provider.clone();
        let backend = state.backend(&core.store, thread)?;
        let entry = state.registry.get(&provider, backend.as_deref())?;
        let read_only = entry
            .capabilities
            .get("childControls")
            .and_then(Value::as_str)
            == Some("read-only");
        if read_only && root_id.as_deref() != Some(agent_id) {
            return Ok(Some(fail("unsupported_child_control")));
        }
    }
    Ok(None)
}
