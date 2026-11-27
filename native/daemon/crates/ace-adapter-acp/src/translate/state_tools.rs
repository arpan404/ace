// SPDX-License-Identifier: Apache-2.0
//! Tool and request indexes (`state.ts` tool/request half).

use crate::translate::state::{
    SENT_LIMIT, SentRequest, TranslationState, UNCERTAIN_SHELL_LIMIT, rpc_key,
};
use ace_json::{JsString, Map};

impl TranslationState {
    pub fn tool_mut(
        &mut self,
        owner_key: &str,
        owner_native_id: &JsString,
        id: &JsString,
    ) -> Option<String> {
        if let Some(owned) = self.owned_tools.get(owner_key)
            && let Some(tool_key) = owned.get(id)
        {
            return Some(tool_key.clone());
        }
        let uncertain = Self::uncertain_key(owner_native_id, id);
        if let Some(retained) = self.uncertain_shells.get(&uncertain).cloned() {
            let tool_key = retained.key.clone();
            let mut restored = retained;
            restored.owner_key = owner_key.to_owned();
            restored.owner_native_id = owner_native_id.clone();
            self.tools.insert(tool_key.clone(), restored);
            self.register_tool(owner_key, id, &tool_key);
            return Some(tool_key);
        }
        None
    }

    pub fn tool_key_for_native(&self, native_id: &JsString) -> Option<String> {
        self.tools_by_native.get(native_id).cloned()
    }

    pub fn retain_uncertain_shell(&mut self, tool_key: &str) {
        let retained = match self.tools.get(tool_key).cloned() {
            Some(tool) => tool,
            None => return,
        };
        let (owner_native_id, native_id) =
            (retained.owner_native_id.clone(), retained.native_id.clone());
        if let Some(tool) = self.tools.get_mut(tool_key) {
            tool.uncertain_shell = true;
        }
        let mut stored = retained;
        stored.uncertain_shell = true;
        let key = Self::uncertain_key(&owner_native_id, &native_id);
        self.uncertain_shells.shift_remove(&key);
        self.uncertain_shells.insert(key, stored);
        if self.uncertain_shells.len() > UNCERTAIN_SHELL_LIMIT
            && let Some((oldest_key, _)) = self
                .uncertain_shells
                .first()
                .map(|(k, v)| (k.clone(), v.clone()))
        {
            self.uncertain_shells.shift_remove(&oldest_key);
            // Clear the flag on any live copy, mirroring the shared reference.
            let mut to_clear: Option<String> = None;
            for (candidate_key, tool) in self.tools.iter() {
                if tool.uncertain_shell {
                    let candidate = Self::uncertain_key(&tool.owner_native_id, &tool.native_id);
                    if candidate == oldest_key {
                        to_clear = Some(candidate_key.clone());
                        break;
                    }
                }
            }
            if let Some(clear_key) = to_clear
                && let Some(tool) = self.tools.get_mut(&clear_key)
            {
                tool.uncertain_shell = false;
            }
        }
    }

    pub fn request(&mut self, id: &crate::translate::data::RpcId, method: &str, params: &Map) {
        let key = rpc_key(id);
        self.sent.insert(
            key.clone(),
            SentRequest {
                method: method.to_owned(),
                params: params.clone(),
            },
        );
        if method == "session/load" {
            self.loads.insert(key.clone());
        }
        if self.sent.len() <= SENT_LIMIT {
            return;
        }
        if let Some((oldest, _)) = self.sent.first().map(|(k, v)| (k.clone(), v.clone())) {
            self.reply_key(&oldest);
        }
    }

    pub fn reply(&mut self, id: &crate::translate::data::RpcId) {
        let key = rpc_key(id);
        self.reply_key(&key);
    }

    fn reply_key(&mut self, key: &JsString) {
        self.sent.shift_remove(key);
        self.loads.shift_remove(key);
    }

    pub fn arm_cancel(&mut self, agent_key: &str, at: i64) {
        if self.agent_by_key_mut(agent_key).is_none() {
            // The root may be addressed before it has a native id.
            return;
        }
        if let Some(agent) = self.agent_by_key_mut(agent_key) {
            agent.cancel_at = Some(at);
        }
        self.cancelling.insert(agent_key.to_owned());
    }

    pub fn disarm_cancel(&mut self, agent_key: &str) {
        if let Some(agent) = self.agent_by_key_mut(agent_key) {
            agent.cancel_at = None;
        }
        self.cancelling.shift_remove(agent_key);
    }

    pub fn settle_shell(&mut self, tool_key: &str) {
        let key = match self.tools.get(tool_key) {
            Some(tool) => Self::uncertain_key(&tool.owner_native_id, &tool.native_id),
            None => return,
        };
        if let Some(tool) = self.tools.get_mut(tool_key) {
            tool.uncertain_shell = false;
        }
        self.uncertain_shells.shift_remove(&key);
    }

    pub fn register_tool(&mut self, owner_key: &str, id: &JsString, tool_key: &str) {
        self.owned_tools
            .entry(owner_key.to_owned())
            .or_default()
            .insert(id.clone(), tool_key.to_owned());
        self.tools_by_native.insert(id.clone(), tool_key.to_owned());
    }
}
