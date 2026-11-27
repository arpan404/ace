// SPDX-License-Identifier: Apache-2.0
//! Snapshot frames (`translator.ts`: snapshots). The authoritative idle read
//! settles turns; inbox and interaction snapshots sync provider queues.

use crate::translate::data::{arr_in, fields, get, n_in_fb, s_in};
use crate::translate::projected::projected;
use crate::translate::state::{NativeState, Out, StateError};
use crate::translate::translator::InteractionExpired;
use crate::translate::translator::Translator;
use crate::translate::usage::{Model, session_usage};
use ace_json::{Map, Value};
use std::collections::HashSet;

impl Translator {
    pub(crate) fn snapshot_message(
        &mut self,
        data: &Map,
        out: &mut Out<'_>,
    ) -> Result<(), StateError> {
        let message = fields(get(data, "message"));
        let id = s_in(message, "id").to_owned();
        let session = s_in(data, "sessionID").to_owned();
        let delivered = s_in(message, "type") == "user" || s_in(message, "type") == "synthetic";
        if delivered && self.state.admission_pending.contains(&id) && !self.state.admitted.has(&id)
        {
            self.state.admit(&id, &session, out)?;
        }
        if delivered {
            self.state.inputs.shift_remove(&id);
            self.state.commands.shift_remove(&id);
            self.state.admission_pending.remove(&id);
        }
        let message_value = get(data, "message").clone();
        projected(&mut self.state, &session, &message_value, out)?;
        if delivered {
            self.state
                .finish_background(&format!("admission:{id}"), "completed", out)?;
            self.state.queue(out)?;
        }
        Ok(())
    }

    pub(crate) fn snapshot_info(
        &mut self,
        data: &Map,
        out: &mut Out<'_>,
    ) -> Result<(), StateError> {
        let info_value = get(data, "info").clone();
        let info = fields(&info_value);
        if matches!(data.get("root"), Some(Value::Bool(true))) && self.state.root_native.is_empty()
        {
            self.state.root_native = s_in(info, "id").to_owned();
        }
        let recovering = matches!(data.get("recovering"), Some(Value::Bool(true)));
        if !matches!(data.get("root"), Some(Value::Bool(true))) && !recovering {
            let probed = info.clone();
            self.state.probed(&probed);
        }
        let id = s_in(info, "id").to_owned();
        self.state.seen(info, out)?;
        let known = self
            .state
            .agents
            .get(&id)
            .and_then(|meta| meta.model.clone());
        let fresh = crate::translate::usage::qualified_model(get(info, "model"));
        let model = match fresh {
            Some(fresh) => Some(Model::Owned(fresh)),
            None => known.as_deref().map(Model::Borrowed),
        };
        if let Some(usage) = session_usage(self.state.key(&id), &id, model, info) {
            out.fact(&usage)?;
        }
        if !recovering {
            self.state.reconcile_outcome(info, out)?;
        }
        Ok(())
    }

    pub(crate) fn snapshot_active(
        &mut self,
        data: &Map,
        out: &mut Out<'_>,
    ) -> Result<(), StateError> {
        let id = s_in(data, "sessionID").to_owned();
        let idle_at = n_in_fb(data, "idleAt", -1.0);
        if !matches!(data.get("running"), Some(Value::Bool(true)))
            && !self.state.can_settle(&id, idle_at)
        {
            return Ok(());
        }
        let turn = format!("recovered:{id}:{}", s_in(data, "revision"));
        if matches!(data.get("running"), Some(Value::Bool(true))) {
            return self.state.start(&id, &turn, out);
        }
        let outcome = match s_in(data, "outcome") {
            "interrupted" => "interrupted",
            "failed" => "failed",
            _ => "completed",
        };
        self.state.reconcile_wake(&id, idle_at, out)?;
        self.state
            .settle_unstarted(&id, idle_at, &turn, outcome, out)?;
        self.state.end(&id, outcome, None, out)
    }

    pub(crate) fn snapshot_interactions(
        &mut self,
        data: &Map,
        out: &mut Out<'_>,
    ) -> Result<(), StateError> {
        let session = s_in(data, "sessionID").to_owned();
        let keys: HashSet<&str> = arr_in(data, "keys")
            .iter()
            .filter_map(|key| match key {
                Value::String(key) => Some(key.as_str()),
                _ => None,
            })
            .collect();
        for key in expired_keys(&self.state, &session, &keys) {
            self.state.pending.shift_remove(&key);
            out.fact(&InteractionExpired {
                typ: "interaction.closed",
                interaction: key,
                state: "expired",
            })?;
        }
        Ok(())
    }

    pub(crate) fn snapshot_inbox(
        &mut self,
        data: &Map,
        out: &mut Out<'_>,
    ) -> Result<(), StateError> {
        let session = s_in(data, "sessionID").to_owned();
        let ids: Vec<String> = arr_in(data, "items")
            .iter()
            .map(|entry| s_in(fields(entry), "id").to_owned())
            .collect();
        // Absence alone cannot distinguish rejection from an accepted input
        // whose inbox entry was consumed before history caught up.
        for id in &ids {
            if self.state.admission_pending.contains(id) && !self.state.admitted.has(id) {
                self.state.admit(id, &session, out)?;
            }
            self.state.admission_pending.remove(id);
            self.state.input(id, &session, out)?;
        }
        self.state.queue(out)
    }
}

/// The pending keys the snapshot no longer lists, in translator order.
pub(crate) fn expired_keys(
    state: &NativeState,
    session: &str,
    keys: &HashSet<&str>,
) -> Vec<String> {
    state
        .pending
        .iter()
        .filter(|(key, pending)| pending.session == session && !keys.contains(key.as_str()))
        .map(|(key, _)| key.to_owned())
        .collect()
}
