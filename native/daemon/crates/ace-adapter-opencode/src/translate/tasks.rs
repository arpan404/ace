// SPDX-License-Identifier: Apache-2.0
//! Bookkeeping work that outlives a turn (`native-state.ts`, second half).
//! OpenCode can report an execution's end before a tool it ran finishes
//! cleaning up. Each such tool is held as bookkeeping work until it settles,
//! so the tree isn't done early. The work is not linked to the tool's row.

use crate::translate::data::s_in;
use crate::translate::state::{NativeState, Out, StateError};
use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Serialize)]
struct BackgroundStarted<'a> {
    #[serde(rename = "type")]
    typ: &'static str,
    agent: &'a str,
    task: &'a str,
    kind: &'a str,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    item: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "childAgent")]
    child_agent: Option<&'a str>,
    stoppable: bool,
}

#[derive(Serialize)]
struct BackgroundEnded<'a> {
    #[serde(rename = "type")]
    typ: &'static str,
    task: &'a str,
    status: &'static str,
}

#[derive(Serialize)]
struct WakeExpected<'a> {
    #[serde(rename = "type")]
    typ: &'static str,
    agent: &'a str,
    until: crate::translate::data::Num,
}

impl NativeState {
    /// Start bookkeeping work, unless it is already held or complete.
    pub fn background(
        &mut self,
        task: &str,
        session: &str,
        kind: &'static str,
        item: Option<&str>,
        out: &mut Out<'_>,
    ) -> Result<(), StateError> {
        if self.backgrounds.has(task) || self.completed_backgrounds.has(task) {
            return Ok(());
        }
        if self.backgrounds.len() >= 2048 {
            return Err(StateError::Limit("work"));
        }
        self.backgrounds.set(task.to_owned(), session.to_owned());
        let title = if task.starts_with("admission:") {
            String::from("OpenCode input acknowledgement uncertain")
        } else if task.starts_with("ancestry:") {
            String::from("Verifying OpenCode child ownership")
        } else if task.starts_with("work:") {
            String::from("Finishing a tool call")
        } else if kind == "shell" {
            String::from("OpenCode shell")
        } else {
            String::from("OpenCode background work")
        };
        let agent = self.key(session).to_owned();
        let child_key;
        let child_agent = if kind == "subagent" {
            child_key = self
                .key(task.strip_prefix("child:").unwrap_or(""))
                .to_owned();
            Some(child_key.as_str())
        } else {
            None
        };
        out.fact(&BackgroundStarted {
            typ: "background.started",
            agent: &agent,
            task,
            kind,
            title,
            item,
            child_agent,
            stoppable: !task.starts_with("admission:") && !task.starts_with("ancestry:"),
        })?;
        Ok(())
    }

    /// End bookkeeping work, if it was held.
    pub fn finish_background(
        &mut self,
        task: &str,
        status: &'static str,
        out: &mut Out<'_>,
    ) -> Result<(), StateError> {
        let exists = self.backgrounds.has(task);
        self.backgrounds.delete(task);
        if !task.starts_with("child:") && (exists || task.starts_with("shell:")) {
            self.completed_backgrounds.add(task);
        }
        if !exists {
            return Ok(());
        }
        out.fact(&BackgroundEnded {
            typ: "background.ended",
            task,
            status,
        })?;
        Ok(())
    }

    /// Hold a tool seen running after its execution ended until it settles.
    pub fn tool_tail(
        &mut self,
        item: &str,
        session: &str,
        out: &mut Out<'_>,
    ) -> Result<(), StateError> {
        self.background(&format!("work:{item}"), session, "other", None, out)
    }

    pub fn tool_tails(&mut self, session: &str, out: &mut Out<'_>) -> Result<(), StateError> {
        let open: Vec<String> = self
            .tools
            .iter()
            .filter(|(_, tool)| tool.session == session && tool.live)
            .map(|(item, _)| item.to_owned())
            .collect();
        for item in open {
            self.tool_tail(&item, session, out)?;
        }
        Ok(())
    }

    /// Expect a wake for the session; recovered snapshots clear it.
    pub fn wake(&mut self, id: &str, created: f64, out: &mut Out<'_>) -> Result<(), StateError> {
        self.wakes.set(id.to_owned(), created);
        let agent = self.key(id).to_owned();
        out.fact(&WakeExpected {
            typ: "wake.expected",
            agent: &agent,
            until: crate::translate::data::Num(9_007_199_254_740_991.0),
        })?;
        Ok(())
    }

    /// Clear a wake whose idle snapshot proves the session already woke.
    pub fn reconcile_wake(
        &mut self,
        id: &str,
        idle_at: f64,
        out: &mut Out<'_>,
    ) -> Result<(), StateError> {
        let created = match self.wakes.get(id) {
            Some(created) => *created,
            None => return Ok(()),
        };
        if idle_at < created {
            return Ok(());
        }
        self.wakes.delete(id);
        let agent = self.key(id).to_owned();
        out.fact(&WakeExpected {
            typ: "wake.expected",
            agent: &agent,
            until: crate::translate::data::Num(0.0),
        })?;
        Ok(())
    }

    /// Dispatch a background child, coalescing repeated claims on one item.
    pub fn child_dispatch(
        &mut self,
        child: &str,
        session: &str,
        item: &str,
        created: f64,
        out: &mut Out<'_>,
    ) -> Result<(), StateError> {
        if created <= self.child_completed_at.get(child).copied().unwrap_or(-1.0) {
            return Ok(());
        }
        let over_item = self
            .child_dispatches
            .get(child)
            .is_some_and(|dispatches| dispatches.len() >= 128 && !dispatches.has(item));
        if over_item {
            return Err(StateError::Limit("child dispatch"));
        }
        if self.child_dispatches.len() >= 1024 && !self.child_dispatches.has(child) {
            return Err(StateError::Limit("child"));
        }
        let is_new = !self
            .child_dispatches
            .get(child)
            .is_some_and(|dispatches| dispatches.has(item));
        if is_new {
            if self.child_dispatch_count >= 2048 {
                return Err(StateError::Limit("dispatch budget"));
            }
            self.child_dispatch_count += 1;
        }
        if !self.child_dispatches.has(child) {
            self.child_dispatches
                .set(child.to_owned(), crate::translate::cache::OrderedMap::new());
        }
        if let Some(dispatches) = self.child_dispatches.get_mut(child) {
            dispatches.set(item.to_owned(), created);
        }
        self.background(
            &format!("child:{child}"),
            session,
            "subagent",
            Some(item),
            out,
        )
    }

    /// Fold a synthetic completion into the child or shell it reports.
    pub fn completion(
        &mut self,
        metadata: &Map<String, Value>,
        created: f64,
        out: &mut Out<'_>,
    ) -> Result<(), StateError> {
        if s_in(metadata, "source") == "subagent" {
            let child = s_in(metadata, "childID").to_owned();
            let previous = self.child_completed_at.get(&child).copied().unwrap_or(-1.0);
            if created <= previous {
                return Ok(());
            }
            self.child_completed_at.set(child.clone(), created);
            let mut acknowledged: Option<String> = None;
            if let Some(dispatches) = self.child_dispatches.get(&child) {
                for (item, started) in dispatches.iter() {
                    if *started <= created {
                        acknowledged = Some(item.to_owned());
                        break;
                    }
                }
            }
            if let Some(item) = acknowledged {
                if let Some(dispatches) = self.child_dispatches.get_mut(&child) {
                    dispatches.delete(&item);
                }
                self.child_dispatch_count -= 1;
            }
            if self
                .child_dispatches
                .get(&child)
                .is_some_and(|dispatches| !dispatches.is_empty())
            {
                return Ok(());
            }
            self.child_dispatches.delete(&child);
        }
        let task = if s_in(metadata, "source") == "subagent" {
            format!("child:{}", s_in(metadata, "childID"))
        } else if s_in(metadata, "source") == "shell" {
            format!("shell:{}", s_in(metadata, "shellID"))
        } else {
            String::new()
        };
        if task.is_empty() {
            return Ok(());
        }
        let state = s_in(metadata, "state");
        self.finish_background(
            &task,
            if state == "error" {
                "failed"
            } else if state == "cancelled" {
                "stopped"
            } else {
                "completed"
            },
            out,
        )
    }
}
