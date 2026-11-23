// SPDX-License-Identifier: Apache-2.0
//! Tool execution handling for the Pi translator.

use super::facts::{
    BackgroundEnded, ItemDelta, RawPayload, ToolCallEnd, ToolCallStart, ToolDraftEnd,
    ToolDraftStart, ToolUpsertEnd, ToolUpsertStart, push_fact,
};
use super::native::{clone_raw, field, raw_type_of};
use super::tools::{
    ace_mcp_error, edit_result_detail, result_is_error, result_suffix, tool_detail, tool_kind,
};
use super::{PiTranslator, ToolEntry};
use ace_core::Fact;
use std::collections::HashMap;

impl PiTranslator {
    pub(super) fn on_tool_start(
        &mut self,
        seq: u64,
        map: &HashMap<String, Box<serde_json::value::RawValue>>,
        data: &serde_json::value::RawValue,
        now: i64,
        out: &mut Vec<Fact>,
    ) -> bool {
        use super::native::str_field;
        let id = str_field(map, "toolCallId");
        let name = str_field(map, "toolName");
        if id.is_empty() {
            if let Some(fact) = self.notice(seq, data, "Pi tool omitted identity", "warning") {
                out.push(fact);
            }
            return true;
        }
        let args_ref = field(map, "args");
        let detail = tool_detail(&name, args_ref);
        let args = args_ref.and_then(clone_raw);
        self.tools.insert(
            id.clone(),
            ToolEntry {
                name: name.clone(),
                args,
                length: 0,
                surviving: false,
            },
        );
        out.extend(self.start());
        out.extend(self.recovered());
        push_fact(
            out,
            "item.upsert",
            &ToolUpsertStart {
                fact_type: "item.upsert".to_owned(),
                agent: self.agent.clone(),
                item: format!("{}:tool:{id}", self.prefix),
                draft: ToolDraftStart {
                    draft_type: "tool_call".to_owned(),
                    complete: false,
                    call: ToolCallStart {
                        kind: tool_kind(&detail),
                        title: name,
                        status: "running".to_owned(),
                        detail,
                        started_at: now,
                        raw: vec![RawPayload {
                            payload_type: raw_type_of(data, "unknown"),
                            data,
                        }],
                    },
                },
            },
        );
        true
    }

    pub(super) fn on_tool_update(
        &mut self,
        seq: u64,
        map: &HashMap<String, Box<serde_json::value::RawValue>>,
        data: &serde_json::value::RawValue,
        now: i64,
        is_end: bool,
        out: &mut Vec<Fact>,
    ) -> bool {
        use super::native::str_field;
        let id = str_field(map, "toolCallId");
        let partial_key = if is_end { "result" } else { "partialResult" };
        let partial = field(map, partial_key);
        let (is_bash, seen) = match self.tools.get(&id) {
            Some(entry) => (entry.name == "bash", entry.length),
            None => {
                if let Some(fact) =
                    self.notice(seq, data, "Pi tool result has no known start", "warning")
                {
                    out.push(fact);
                }
                return true;
            }
        };
        if is_bash {
            let (append, length) = result_suffix(partial, seen);
            if length > seen {
                push_fact(
                    out,
                    "item.delta",
                    &ItemDelta {
                        fact_type: "item.delta".to_owned(),
                        agent: self.agent.clone(),
                        item: format!("{}:tool:{id}", self.prefix),
                        field: "output".to_owned(),
                        append,
                    },
                );
                if let Some(entry) = self.tools.get_mut(&id) {
                    entry.length = length;
                }
            }
        }
        if !is_end {
            return false;
        }
        let (name, args, surviving) = match self.tools.get(&id) {
            Some(entry) => (entry.name.clone(), entry.args.clone(), entry.surviving),
            None => return true,
        };
        let failed = super::native::bool_field(map, "isError").unwrap_or(false)
            || ace_mcp_error(map)
            || result_is_error(map);
        let edited = edit_result_detail(&name, args.as_deref(), partial);
        let status = if failed { "failed" } else { "succeeded" };
        push_fact(
            out,
            "item.upsert",
            &ToolUpsertEnd {
                fact_type: "item.upsert".to_owned(),
                agent: self.agent.clone(),
                item: format!("{}:tool:{id}", self.prefix),
                draft: ToolDraftEnd {
                    draft_type: "tool_call".to_owned(),
                    complete: true,
                    call: ToolCallEnd {
                        status: status.to_owned(),
                        detail: edited,
                        ended_at: now,
                        raw: vec![RawPayload {
                            payload_type: raw_type_of(data, "unknown"),
                            data,
                        }],
                    },
                },
            },
        );
        if surviving {
            push_fact(
                out,
                "background.ended",
                &BackgroundEnded {
                    fact_type: "background.ended".to_owned(),
                    task: format!("{}:tool:{id}", self.prefix),
                    status: status.to_owned(),
                },
            );
        }
        self.tools.remove(&id);
        true
    }
}
