// SPDX-License-Identifier: Apache-2.0
//! A tool call and a background task as `JSON.stringify` writes them. Both are parsed into the
//! protocol's order, and both take fields the fold fills in later (`backgroundTaskId`, a task's
//! owning call, its output file): JavaScript appends a new own key at the end, so those are
//! written after the parsed ones, in the order they first appeared.

use serde::Serialize;
use serde::ser::{SerializeMap, Serializer};

use crate::entity_model::BackgroundTask;
use crate::item_model::ToolCall;

/// Write one field unless the fold appended it (those go last, in the order they appeared).
macro_rules! field {
    ($trailing:ident, $key:literal, $write:expr) => {
        if !$trailing.contains(&$key) {
            $write?;
        }
    };
}

impl Serialize for ToolCall {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        let trailing = &self.trailing;
        field!(trailing, "id", map.serialize_entry("id", &self.id));
        field!(
            trailing,
            "agentId",
            map.serialize_entry("agentId", &self.agent_id)
        );
        field!(trailing, "kind", map.serialize_entry("kind", &self.kind));
        field!(trailing, "title", map.serialize_entry("title", &self.title));
        field!(
            trailing,
            "status",
            map.serialize_entry("status", &self.status)
        );
        field!(
            trailing,
            "detail",
            map.serialize_entry("detail", &self.detail)
        );
        field!(trailing, "backgroundTaskId", {
            if let Some(value) = &self.background_task_id {
                map.serialize_entry("backgroundTaskId", value)
            } else {
                Ok(())
            }
        });
        field!(trailing, "error", {
            if let Some(value) = &self.error {
                map.serialize_entry("error", value)
            } else {
                Ok(())
            }
        });
        field!(trailing, "result", {
            if let Some(value) = &self.result {
                map.serialize_entry("result", value)
            } else {
                Ok(())
            }
        });
        field!(trailing, "startedAt", {
            map.serialize_entry("startedAt", &self.started_at)
        });
        field!(trailing, "endedAt", {
            if let Some(value) = &self.ended_at {
                map.serialize_entry("endedAt", value)
            } else {
                Ok(())
            }
        });
        field!(trailing, "raw", map.serialize_entry("raw", &self.raw));
        for (key, value) in &self.extra {
            map.serialize_entry(key, value)?;
        }
        for key in trailing {
            match *key {
                "backgroundTaskId" => {
                    if let Some(value) = &self.background_task_id {
                        map.serialize_entry("backgroundTaskId", value)?;
                    }
                }
                "error" => {
                    if let Some(value) = &self.error {
                        map.serialize_entry("error", value)?;
                    }
                }
                "result" => {
                    if let Some(value) = &self.result {
                        map.serialize_entry("result", value)?;
                    }
                }
                "endedAt" => {
                    if let Some(value) = &self.ended_at {
                        map.serialize_entry("endedAt", value)?;
                    }
                }
                _ => {}
            }
        }
        map.end()
    }
}

impl Serialize for BackgroundTask {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        let trailing = &self.trailing;
        field!(trailing, "id", map.serialize_entry("id", &self.id));
        field!(trailing, "agentId", {
            map.serialize_entry("agentId", &self.agent_id)
        });
        field!(trailing, "kind", map.serialize_entry("kind", &self.kind));
        field!(trailing, "owner", {
            if let Some(value) = &self.owner {
                map.serialize_entry("owner", value)
            } else {
                Ok(())
            }
        });
        field!(trailing, "title", map.serialize_entry("title", &self.title));
        field!(
            trailing,
            "status",
            map.serialize_entry("status", &self.status)
        );
        field!(trailing, "ambient", {
            map.serialize_entry("ambient", &self.ambient)
        });
        field!(trailing, "internal", {
            if let Some(value) = &self.internal {
                map.serialize_entry("internal", value)
            } else {
                Ok(())
            }
        });
        field!(trailing, "stoppable", {
            map.serialize_entry("stoppable", &self.stoppable)
        });
        field!(trailing, "startedAt", {
            map.serialize_entry("startedAt", &self.started_at)
        });
        field!(trailing, "raw", map.serialize_entry("raw", &self.raw));
        field!(trailing, "toolCallId", {
            if let Some(value) = &self.tool_call_id {
                map.serialize_entry("toolCallId", value)
            } else {
                Ok(())
            }
        });
        field!(trailing, "childAgentId", {
            if let Some(value) = &self.child_agent_id {
                map.serialize_entry("childAgentId", value)
            } else {
                Ok(())
            }
        });
        field!(trailing, "outputPath", {
            if let Some(value) = &self.output_path {
                map.serialize_entry("outputPath", value)
            } else {
                Ok(())
            }
        });
        field!(trailing, "wakesAgent", {
            if let Some(value) = &self.wakes_agent {
                map.serialize_entry("wakesAgent", value)
            } else {
                Ok(())
            }
        });
        field!(trailing, "blocksPrompts", {
            if let Some(value) = &self.blocks_prompts {
                map.serialize_entry("blocksPrompts", value)
            } else {
                Ok(())
            }
        });
        field!(trailing, "endsWithSession", {
            if let Some(value) = &self.ends_with_session {
                map.serialize_entry("endsWithSession", value)
            } else {
                Ok(())
            }
        });
        field!(trailing, "listening", {
            if let Some(value) = &self.listening {
                map.serialize_entry("listening", value)
            } else {
                Ok(())
            }
        });
        for (key, value) in &self.extra {
            map.serialize_entry(key, value)?;
        }
        for key in trailing {
            match *key {
                "toolCallId" => {
                    if let Some(value) = &self.tool_call_id {
                        map.serialize_entry("toolCallId", value)?;
                    }
                }
                "childAgentId" => {
                    if let Some(value) = &self.child_agent_id {
                        map.serialize_entry("childAgentId", value)?;
                    }
                }
                "outputPath" => {
                    if let Some(value) = &self.output_path {
                        map.serialize_entry("outputPath", value)?;
                    }
                }
                "wakesAgent" => {
                    if let Some(value) = &self.wakes_agent {
                        map.serialize_entry("wakesAgent", value)?;
                    }
                }
                "blocksPrompts" => {
                    if let Some(value) = &self.blocks_prompts {
                        map.serialize_entry("blocksPrompts", value)?;
                    }
                }
                "endsWithSession" => {
                    if let Some(value) = &self.ends_with_session {
                        map.serialize_entry("endsWithSession", value)?;
                    }
                }
                "listening" => {
                    if let Some(value) = &self.listening {
                        map.serialize_entry("listening", value)?;
                    }
                }
                _ => {}
            }
        }
        // A task ends after everything it announced: `endedAt` is the last key set.
        if let Some(ended_at) = &self.ended_at {
            map.serialize_entry("endedAt", ended_at)?;
        }
        map.end()
    }
}
