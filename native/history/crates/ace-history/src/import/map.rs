// SPDX-License-Identifier: Apache-2.0

//! `mapHistory` (`map-history.ts`): one native record as ace items. File transcripts differ from
//! live notifications, and nothing here is shared with live sessions; unmapped records are kept as
//! hidden raw entries, never dropped.

use history_text::{js, sanitize_user_text};
use serde_json::{Map, Value, json};

use super::plan::{CompactSummary, Plan};
use super::tools::tool_detail;
use crate::error::Result;
use crate::json::{field, is_true, object, present, string, timestamp};
use crate::options::Provider;

pub struct Context<'a> {
    pub provider: Provider,
    pub agent_id: &'a str,
    pub id_prefix: &'a str,
    pub at: i64,
    pub raw: Value,
    pub plan: &'a Plan,
}

pub struct Mapped {
    pub item: Value,
    /// Whether this item counts as one native message.
    pub message: bool,
}

struct Mapper<'a, 'b> {
    ctx: &'b Context<'a>,
    role: Option<String>,
    at: i64,
    seq: usize,
    raw_taken: bool,
    linked_call: Option<String>,
    out: Vec<Mapped>,
}

fn token_count(value: &Value) -> Option<i64> {
    value.as_i64().filter(|n| *n >= 0).or_else(|| {
        value
            .as_f64()
            .filter(|f| f.fract() == 0.0 && *f >= 0.0)
            .map(|f| f as i64)
    })
}

impl Mapper<'_, '_> {
    fn raw(&mut self) -> Value {
        if self.raw_taken {
            return json!([]);
        }
        self.raw_taken = true;
        json!([self.ctx.raw])
    }

    fn base(&mut self, kind: &str) -> Map<String, Value> {
        let mut item = Map::new();
        item.insert(
            "id".into(),
            json!(format!("{}:{}", self.ctx.id_prefix, self.seq)),
        );
        self.seq += 1;
        item.insert("agentId".into(), json!(self.ctx.agent_id));
        item.insert("createdAt".into(), json!(self.at));
        item.insert("complete".into(), json!(true));
        item.insert("type".into(), json!(kind));
        item
    }

    fn push(&mut self, item: Map<String, Value>, message: bool) {
        self.out.push(Mapped {
            item: Value::Object(item),
            message,
        });
    }

    fn notice(&mut self, text: &str) {
        let mut item = self.base("notice");
        item.insert("level".into(), json!("info"));
        if let Some(call) = &self.linked_call {
            item.insert("toolCallId".into(), json!(call));
        }
        item.insert("text".into(), json!(js::prefix(text, 4096)));
        item.insert("raw".into(), self.raw());
        self.push(item, false);
    }

    fn raw_only(&mut self, message: bool) {
        let mut item = self.base("notice");
        item.insert("level".into(), json!("info"));
        item.insert("code".into(), json!("history.raw-only"));
        item.insert("text".into(), json!(""));
        item.insert("raw".into(), self.raw());
        self.push(item, message);
    }

    /// Bounded text items also bound event and page sizes after a large native block.
    fn texts(&mut self, kind: &str, text: &str, is_message: bool) {
        let cleaned;
        let mut text = text;
        if self.role.as_deref() == Some("user") {
            cleaned = sanitize_user_text(text);
            text = &cleaned;
            if text.is_empty() {
                self.raw_only(false);
                return;
            }
        }
        let units = js::length(text);
        let mut offset = 0;
        while offset < units || offset == 0 {
            let chunk = js::slice(text, offset, offset + 4096);
            let mut item = self.base(kind);
            match kind {
                "message" => {
                    let role = if self.role.as_deref() == Some("user") {
                        "user"
                    } else {
                        "assistant"
                    };
                    item.insert("role".into(), json!(role));
                    item.insert("parts".into(), json!([{ "type": "text", "text": chunk }]));
                    item.insert("raw".into(), self.raw());
                }
                "notice" => {
                    item.insert("level".into(), json!("info"));
                    item.insert("text".into(), json!(chunk));
                    item.insert("raw".into(), self.raw());
                    if let Some(call) = &self.linked_call {
                        item.insert("toolCallId".into(), json!(call));
                    }
                }
                _ => {
                    item.insert("text".into(), json!(chunk));
                    item.insert("raw".into(), self.raw());
                }
            }
            self.push(item, is_message && offset == 0);
            offset += 4096;
        }
    }

    fn tool(&mut self, block: &Map<String, Value>) -> String {
        let mut item = self.base("tool_call");
        let id = item["id"].clone();
        let state = object(field(block, "state"));
        let detail = tool_detail(block);
        let status = match string(state, "status") {
            Some("error") => "failed",
            Some("completed") => "succeeded",
            Some("running") => "running",
            _ => "pending",
        };
        let title = string(block, "name")
            .or_else(|| string(block, "tool"))
            .unwrap_or("Native tool");
        let call = json!({
            "id": id,
            "agentId": self.ctx.agent_id,
            "kind": detail["kind"],
            "title": js::prefix(title, 256),
            "status": status,
            "detail": detail,
            "startedAt": self.at,
            "raw": self.raw(),
        });
        item.insert("call".into(), call);
        self.push(item, false);
        id.as_str().unwrap_or_default().to_owned()
    }

    fn compaction(&mut self) {
        let item = self.base("compaction");
        self.push(item, false);
    }

    fn image(&mut self, block: &Map<String, Value>, counted: &mut bool) {
        let source = object(field(block, "source"));
        let url = string(block, "image_url")
            .map(str::to_owned)
            .or_else(|| string(object(field(block, "image_url")), "url").map(str::to_owned))
            .or_else(|| string(block, "url").map(str::to_owned))
            .or_else(|| match (string(source, "type"), field(source, "data")) {
                (Some("base64"), Value::String(data)) => Some(format!(
                    "data:{};base64,{data}",
                    string(source, "media_type").unwrap_or("image/*")
                )),
                _ => string(source, "url").map(str::to_owned),
            });
        let Some(url) = url.filter(|u| js::length(u) <= 128 * 1024) else {
            self.raw_only(false);
            return;
        };
        let from_data = url
            .strip_prefix("data:")
            .map(|rest| rest.split([';', ',']).next().unwrap_or(""))
            .filter(|m| !m.is_empty());
        let mime = from_data
            .or_else(|| string(source, "media_type"))
            .or_else(|| string(block, "mime"))
            .unwrap_or("image/*")
            .to_owned();
        let lower = url.to_ascii_lowercase();
        let image = lower.starts_with("data:image/")
            || lower.starts_with("http:")
            || lower.starts_with("https:")
            || lower.starts_with("blob:");
        let part = if image {
            json!({ "type": "image", "mimeType": mime, "url": url })
        } else {
            json!({ "type": "file", "mimeType": mime, "path": url })
        };
        let mut item = self.base("message");
        item.insert("role".into(), json!(self.role.clone().unwrap_or_default()));
        item.insert("parts".into(), json!([part]));
        item.insert("raw".into(), self.raw());
        self.push(item, !*counted);
        *counted = true;
    }
}

/// Map one record. Plan lookups resolve tool results and compaction summaries.
pub fn map_history(value: &Value, ctx: &Context<'_>) -> Result<Vec<Mapped>> {
    let r = object(value);
    let p = if ctx.provider == Provider::Codex && string(r, "type") == Some("response_item") {
        object(field(r, "payload"))
    } else {
        r
    };
    let message = if matches!(ctx.provider, Provider::Claude | Provider::Pi) {
        object(field(p, "message"))
    } else {
        p
    };
    let role = string(message, "role")
        .map(str::to_owned)
        .or_else(|| match string(p, "type") {
            Some(kind @ ("user" | "assistant")) => Some(kind.to_owned()),
            _ => None,
        });
    let at = timestamp(field(r, "timestamp"))
        .or_else(|| timestamp(field(object(field(p, "time")), "created")))
        .unwrap_or(ctx.at);
    let mut m = Mapper {
        ctx,
        role: role.clone(),
        at,
        seq: 0,
        raw_taken: false,
        linked_call: None,
        out: Vec::new(),
    };
    let kind = string(p, "type");
    if ctx.provider == Provider::Pi && string(r, "type") != Some("message") {
        m.raw_only(false);
        return Ok(m.out);
    }
    if ctx.provider == Provider::Codex {
        if matches!(
            string(r, "type"),
            Some("event_msg" | "turn_context" | "session_meta")
        ) {
            m.raw_only(false);
            return Ok(m.out);
        }
        if matches!(kind, Some("function_call" | "custom_tool_call")) {
            m.tool(p);
            return Ok(m.out);
        }
        if matches!(
            kind,
            Some("function_call_output" | "custom_tool_call_output")
        ) {
            m.linked_call = match string(p, "call_id") {
                Some(native) => ctx.plan.call_item(native)?,
                None => None,
            };
            match string(p, "output").filter(|o| !o.is_empty()) {
                Some(output) => m.texts("notice", output, false),
                None => m.notice("Native tool result"),
            }
            return Ok(m.out);
        }
        if kind == Some("reasoning") {
            let mut readable = false;
            if let Some(parts) = field(p, "summary").as_array() {
                for part in parts {
                    if let Some(text) = string(object(part), "text").filter(|t| !t.is_empty()) {
                        readable = true;
                        m.texts("reasoning", text, false);
                    }
                }
            }
            if !readable {
                m.raw_only(false);
            }
            return Ok(m.out);
        }
        if string(r, "type") == Some("compacted") {
            m.compaction();
            m.notice("Native compaction record");
            return Ok(m.out);
        }
    }
    if ctx.provider == Provider::Opencode && kind == Some("tool") {
        let call = m.tool(p);
        m.linked_call = Some(call);
        if let Some(output) = string(object(field(p, "state")), "output").filter(|o| !o.is_empty())
        {
            m.texts("notice", output, false);
        }
        return Ok(m.out);
    }
    if matches!(kind, Some("reasoning" | "thinking")) {
        let text = string(p, "text")
            .or_else(|| string(p, "thinking"))
            .unwrap_or("");
        m.texts("reasoning", text, false);
        return Ok(m.out);
    }
    if ctx.provider == Provider::Opencode && kind == Some("text") {
        if !is_true(p, "synthetic") {
            m.texts("message", string(p, "text").unwrap_or(""), false);
        }
        return Ok(m.out);
    }
    let user = role.as_deref() == Some("user");
    // Claude's compaction summary is provider-internal text, never the person's words.
    if user
        && is_true(p, "isCompactSummary")
        && ctx.plan.folds_summary(string(p, "uuid").unwrap_or(""))?
    {
        return Ok(m.out);
    }
    if user && (is_true(p, "isMeta") || is_true(p, "synthetic") || is_true(p, "isCompactSummary")) {
        m.raw_only(false);
        return Ok(m.out);
    }
    let mut content = present(message.get("content"))
        .or_else(|| present(p.get("content")))
        .or_else(|| if user { present(p.get("text")) } else { None })
        .cloned();
    if ctx.provider == Provider::Opencode {
        if let Some(files) = field(p, "files").as_array().filter(|f| !f.is_empty()) {
            let mut joined = match &content {
                Some(Value::String(s)) => vec![json!({ "type": "text", "text": s })],
                Some(Value::Array(items)) => items.clone(),
                _ => Vec::new(),
            };
            joined.extend(files.iter().cloned());
            content = Some(Value::Array(joined));
        } else if kind == Some("file") {
            content = Some(json!([p]));
        }
        if matches!(role.as_deref(), Some("user" | "assistant")) && content.is_none() {
            m.raw_only(true);
            return Ok(m.out);
        }
    }
    if matches!(role.as_deref(), Some("user" | "assistant")) {
        match &content {
            Some(Value::String(text)) => {
                m.texts("message", text, true);
                return Ok(m.out);
            }
            Some(Value::Array(parts)) => {
                blocks(&mut m, parts)?;
                return Ok(m.out);
            }
            _ => {}
        }
    }
    if ctx.provider == Provider::Opencode && kind == Some("compaction") {
        m.compaction();
        return Ok(m.out);
    }
    if ctx.provider == Provider::Claude
        && kind == Some("system")
        && string(p, "subtype") == Some("compact_boundary")
    {
        let summary = match string(p, "uuid") {
            Some(uuid) => ctx.plan.compact_summary(uuid)?,
            None => None,
        };
        let meta = object(field(p, "compactMetadata"));
        let mut item = m.base("compaction");
        if let Some(before) = token_count(field(meta, "preTokens")) {
            item.insert("tokensBefore".into(), json!(before));
        }
        if let Some(after) = token_count(field(meta, "postTokens")) {
            item.insert("tokensAfter".into(), json!(after));
        }
        let mut raw = m.raw().as_array().cloned().unwrap_or_default();
        if let Some(CompactSummary { text, data }) = summary {
            item.insert("summary".into(), json!(text));
            if let Some(data) = data {
                raw.push(json!({ "type": "user", "data": data }));
            }
        }
        item.insert("raw".into(), Value::Array(raw));
        m.push(item, false);
        return Ok(m.out);
    }
    m.raw_only(false);
    Ok(m.out)
}

fn blocks(m: &mut Mapper<'_, '_>, parts: &[Value]) -> Result<()> {
    let mut counted = false;
    for part in parts {
        let block = object(part);
        let kind = string(block, "type");
        let text = string(block, "text").filter(|t| !t.is_empty());
        if let (Some(text), Some("text" | "input_text" | "output_text")) = (text, kind) {
            m.texts("message", text, !counted);
            counted = true;
        } else if kind == Some("reasoning") {
            m.texts("reasoning", string(block, "text").unwrap_or(""), false);
        } else if kind == Some("tool") {
            let call = m.tool(block);
            m.linked_call = Some(call);
            let state = object(field(block, "state"));
            if let Some(output) = string(state, "output").filter(|o| !o.is_empty()) {
                m.texts("notice", output, false);
            }
            if let Some(results) = field(state, "content").as_array() {
                for result in results {
                    match string(object(result), "text").filter(|t| !t.is_empty()) {
                        Some(text) => m.texts("notice", text, false),
                        None => m.raw_only(false),
                    }
                }
            }
        } else if kind == Some("thinking") {
            m.texts("reasoning", string(block, "thinking").unwrap_or(""), false);
        } else if kind == Some("tool_use") {
            m.tool(block);
        } else if kind == Some("tool_result") {
            m.linked_call = match string(block, "tool_use_id") {
                Some(native) => m.ctx.plan.call_item(native)?,
                None => None,
            };
            match string(block, "content").filter(|c| !c.is_empty()) {
                Some(result) => m.texts("notice", result, false),
                None => m.notice("Native tool result"),
            }
        } else if matches!(kind, Some("image" | "input_image"))
            || (kind == Some("file") && string(block, "mime").unwrap_or("").starts_with("image/"))
        {
            m.image(block, &mut counted);
        } else {
            m.raw_only(false);
        }
    }
    // Count native messages even if their only content is tools or attachments.
    if !counted {
        m.raw_only(true);
    }
    Ok(())
}
