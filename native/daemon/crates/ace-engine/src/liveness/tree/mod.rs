// SPDX-License-Identifier: Apache-2.0
//! `thread-liveness.ts`'s tree read (E5.10): a thread and every delegated child thread it owns
//! on this machine, parents first.

use std::collections::HashSet;

use crate::{Core, EngineError, State};

/// Inputs that resume when their thread runs again; everything else needs a live session.
pub const RESUMABLE: [&str; 8] = [
    "thread.send",
    "thread.create",
    "thread.fork",
    "thread.switch",
    "thread.merge",
    "thread.resume",
    "queue.resume",
    "thread.limit",
];

/// `resumable.has(kind)`.
pub fn resumable(kind: &str) -> bool {
    RESUMABLE.contains(&kind)
}

/// `threadTree`: breadth first, each thread once. A child on another machine lives there, so its
/// machine's own tree owns it.
pub fn thread_tree(core: &Core, state: &mut State, id: &str) -> Result<Vec<String>, EngineError> {
    let mut ids = vec![id.to_owned()];
    let mut seen: HashSet<String> = HashSet::from([id.to_owned()]);
    let mut next = 0;
    while next < ids.len() {
        let owner = ids[next].clone();
        next += 1;
        let Some(snapshot) = state.repo.state(&core.store, &owner)? else {
            continue;
        };
        let children: Vec<String> = {
            let mut borrowed = snapshot.borrow_mut();
            borrowed.hydrate_agents()?;
            borrowed
                .state
                .agents
                .values()
                .filter(|record| record.agent.machine.is_none())
                .filter_map(|record| record.agent.child_thread_id.clone())
                .collect()
        };
        for child in children {
            if seen.insert(child.clone()) {
                ids.push(child);
            }
        }
    }
    Ok(ids)
}

#[cfg(test)]
mod tests;
