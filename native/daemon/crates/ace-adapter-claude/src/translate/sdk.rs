// SPDX-License-Identifier: Apache-2.0
//! The SDK frame dispatcher (the `sdk` closure of `translator.ts`, split
//! from `translate.rs` to keep modules small).

use ace_json::Value;

use super::ClaudeTranslator;
use super::compaction::{compact_boundary, compact_summary};
use super::content::message;
use super::frame::FrameView;
use super::goal::{GoalOut, claude_goal};
use super::json::{number, object, str_of};
use super::rate_limits::{clear_rate_limit, clear_retry, rate_limit_facts};
use super::sdk_facts::{
    activity, agent_linked, ended_error, goal_cleared, goal_updated, interaction_closed,
    model_answered, retry, retry_cleared, title_upsert, turn_ended, wake_expected,
};
use super::stream::{finish_stream, stream};
use super::system_notices::system_notice;
use super::task_frames::task_frame;

pub(crate) fn sdk_translator(
    t: &mut ClaudeTranslator,
    data: &Value,
    frame: &FrameView<'_>,
    now: i64,
) -> bool {
    let obj = object(data);
    let kind = str_of(obj.get("type").unwrap_or(&Value::Null));
    if kind == "summary" {
        if let Some(Value::String(summary)) = obj.get("summary") {
            let root = t.state.root.clone();
            let text = summary.clone();
            t.state.emit(title_upsert(&root, &text));
            return true;
        }
        return false;
    }
    if kind == "system" {
        if task_frame(&mut t.state, data, now) {
            return true;
        }
        let subtype = str_of(obj.get("subtype").unwrap_or(&Value::Null));
        if subtype == "init" {
            clear_rate_limit(&mut t.state);
            if let Some(Value::String(model)) = obj.get("model")
                && !model.is_empty()
            {
                t.state.model = Some(String::from(model.clone()));
                let root = t.state.root.clone();
                let model_clone = model.clone();
                t.state.emit(agent_linked(&root, &model_clone));
            }
            let trigger = if t.state.sent {
                "user".to_owned()
            } else {
                t.state.wake.clone().unwrap_or_else(|| "unknown".to_owned())
            };
            let root = t.state.root.clone();
            t.state.start(&root, &trigger);
            t.state.errors.remove(&t.state.root.clone());
            t.state.sent = false;
            t.state.wake = None;
            t.state.wake_during_turn = false;
            return true;
        }
        if subtype == "compact_boundary" {
            compact_boundary(&mut t.state, data, frame.seq);
            return true;
        }
        if subtype == "status" || subtype == "thinking_tokens" {
            let activity_name = if obj.get("status").and_then(|v| v.as_str()) == Some("compacting")
            {
                "compacting"
            } else if subtype == "thinking_tokens"
                || t.state.content_seen.contains(&t.state.root.clone())
            {
                "thinking"
            } else {
                "starting_turn"
            };
            let root = t.state.root.clone();
            t.state.emit(activity(&root, activity_name));
            return true;
        }
        if subtype == "api_retry" {
            let error = str_of(obj.get("error").unwrap_or(&Value::Null));
            let on = match obj.get("error_status") {
                None | Some(Value::Null) => "network",
                _ => "upstream",
            };
            t.state.retry_on = Some(on.to_owned());
            let attempt = number(obj.get("attempt").unwrap_or(&Value::Null));
            let root = t.state.root.clone();
            t.state.emit(retry(
                &root,
                on,
                &error,
                if attempt > 0.0 {
                    Some(attempt.floor() as i64)
                } else {
                    None
                },
            ));
            return true;
        }
        if subtype == "session_state_changed" {
            let status = str_of(obj.get("state").unwrap_or(&Value::Null));
            t.state.session_state = Some(status.clone());
            let root = t.state.root.clone();
            if status == "idle" {
                t.state.emit(retry_cleared(&root));
            } else if !t.state.active.contains(&root) {
                t.state.emit(retry(
                    &root,
                    "upstream",
                    "Claude session has not settled",
                    None,
                ));
            }
            return true;
        }
        if let Some(notice) = system_notice(data) {
            let agent = t.state.agent_for(data);
            let seq = frame.seq.to_string();
            t.state
                .notice(data, &seq, &agent, &notice.level, Some(&notice.text));
            return true;
        }
        return false;
    }
    if kind == "stream_event" {
        if obj
            .get("parent_tool_use_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .is_empty()
            && str_of(
                object(obj.get("event").unwrap_or(&Value::Null))
                    .get("type")
                    .unwrap_or(&Value::Null),
            ) == "message_start"
        {
            clear_rate_limit(&mut t.state);
            clear_retry(&mut t.state);
        }
        stream(&mut t.state, data, &mut t.streams);
        return true;
    }
    if kind == "assistant" || kind == "user" {
        if frame.dir == "send" && kind == "user" {
            t.state.sent = true;
            let root = t.state.root.clone();
            t.state.start(&root, "user");
        }
        if frame.dir != "send" && compact_summary(&mut t.state, data, frame.seq) {
            return true;
        }
        message(
            &mut t.state,
            data,
            frame.seq,
            &mut t.streams,
            &mut t.messages,
        );
        return true;
    }
    if kind == "active_goal" {
        match claude_goal(data) {
            GoalOut::Goal(goal) => {
                let root = t.state.root.clone();
                t.state.emit(goal_updated(&root, goal));
            }
            GoalOut::Null => {
                let root = t.state.root.clone();
                t.state.emit(goal_cleared(&root));
            }
            GoalOut::None => {}
        }
        return true;
    }
    if kind == "conversation_reset" {
        t.accounting.reset(data);
        return true;
    }
    if kind == "result" {
        let root = t.state.root.clone();
        finish_stream(&mut t.state, &mut t.streams, &root);
        let aborted =
            str_of(obj.get("terminal_reason").unwrap_or(&Value::Null)).starts_with("aborted_");
        if t.steers.carries_on(aborted) {
            t.messages.end_root();
            t.state.release_turn();
            let extra = t.accounting.facts(&mut t.state, data);
            for fact in extra {
                t.state.emit(fact);
            }
            return true;
        }
        let root = t.state.root.clone();
        let last_error = t.state.errors.get(&root).cloned();
        let notified = object(obj.get("origin").unwrap_or(&Value::Null))
            .get("kind")
            .and_then(|v| v.as_str())
            == Some("task-notification");
        let folded = notified
            && !aborted
            && obj.get("is_error") != Some(&Value::Bool(true))
            && last_error.is_none()
            && !t.state.content_seen.contains(&root)
            && !model_answered(data);
        let error = last_error.or_else(|| {
            if folded {
                t.state.root_failure.clone()
            } else {
                None
            }
        });
        let failed =
            !aborted && (obj.get("is_error") == Some(&Value::Bool(true)) || error.is_some());
        if !failed && !aborted {
            clear_rate_limit(&mut t.state);
        }
        if (t.state.wake_during_turn && !notified) || folded {
            if t.state.wake.is_none() {
                t.state.wake = Some(if t.state.run_trigger == "subagent_result" {
                    "subagent_result".to_owned()
                } else {
                    "background_completion".to_owned()
                });
            }
            t.state.wake_until = Some(now + 5_000);
            let until = t.state.wake_until.unwrap_or(0);
            t.state.emit(wake_expected(&root, until));
        }
        let ended = if failed {
            Some(ended_error(
                error.as_ref(),
                &str_of(obj.get("result").unwrap_or(&Value::Null)),
            ))
        } else {
            None
        };
        let run_trigger = t.state.run_trigger.clone();
        let trigger: &str = if notified {
            if run_trigger == "subagent_result" {
                "subagent_result"
            } else {
                "background_completion"
            }
        } else if run_trigger == "unknown" {
            "user"
        } else {
            run_trigger.as_str()
        };
        let outcome = if aborted {
            "interrupted"
        } else if failed {
            "failed"
        } else {
            "completed"
        };
        t.state
            .emit(turn_ended(&root, outcome, trigger, ended.clone()));
        if ended.is_some() || !folded {
            t.state.root_failure = ended;
        }
        t.state.active.remove(&root);
        t.messages.end_root();
        t.state.release_turn();
        if t.state
            .session_state
            .as_deref()
            .map(|s| !s.is_empty() && s != "idle")
            .unwrap_or(false)
        {
            t.state.emit(retry(
                &root,
                "upstream",
                "Claude session has not settled",
                None,
            ));
        }
        let extra = t.accounting.facts(&mut t.state, data);
        for fact in extra {
            t.state.emit(fact);
        }
        return true;
    }
    if kind == "rate_limit_event" {
        rate_limit_facts(&mut t.state, data);
        return true;
    }
    if kind == "control_cancel_request" {
        let id = str_of(obj.get("request_id").unwrap_or(&Value::Null));
        if t.state.interactions.remove(&id).is_some() {
            let interaction = t.state.key("interaction", &id);
            t.state
                .emit(interaction_closed(&interaction, "cancelled", None));
        }
        return true;
    }
    kind == "keep_alive" || kind == "control_response"
}
