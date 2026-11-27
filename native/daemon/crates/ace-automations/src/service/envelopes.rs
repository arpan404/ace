// SPDX-License-Identifier: Apache-2.0
//! `AutomationRequest` envelopes, split from the service's lifecycle: `automation.put`,
//! `remove`, `setEnabled`, `retry`, `run`, `list` and `inbox` (`service.ts:800`). They only
//! read the service's own state through its public calls and the store's bounded reads.

use std::collections::{BTreeMap, HashMap};

use ace_json::{Map, Value};

use super::Service;
use crate::error::{AutomationsError, Result};
use crate::store::{Definition, JobMetadata};

impl<'a> Service<'a> {
    /// Every `AutomationRequest` envelope (`service.ts:800`).
    pub fn handle(&mut self, request: &Value) -> Value {
        let object = match request {
            Value::Object(object) => object,
            _ => return result_error("", "Invalid automation request"),
        };
        let request_id = object
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let kind = object.get("type").and_then(Value::as_str).unwrap_or("");
        let outcome =
            (|| -> Result<Map> {
                let mut result = Map::new();
                result.insert("type", Value::String("automation.result".into()));
                result.insert("requestId", Value::String(request_id.as_str().into()));
                match kind {
                    "automation.put" => {
                        let automation = object.get("automation").ok_or_else(|| {
                            AutomationsError::message("Invalid automation request")
                        })?;
                        let definition = Definition::normalize(automation)?;
                        let expected = expected_revision(object.get("expectedRevision"))?;
                        self.put(&definition, expected)?;
                    }
                    "automation.remove" => {
                        let id = object.get("id").and_then(Value::as_str).ok_or_else(|| {
                            AutomationsError::message("Invalid automation request")
                        })?;
                        self.remove(id, expected_revision(object.get("expectedRevision"))?)?;
                    }
                    "automation.setEnabled" => {
                        let id = object.get("id").and_then(Value::as_str).ok_or_else(|| {
                            AutomationsError::message("Invalid automation request")
                        })?;
                        let enabled = object
                            .get("enabled")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        let expected = object.get("expectedRevision").and_then(Value::as_i64);
                        self.set_enabled(id, enabled, expected)?;
                    }
                    "automation.retry" => {
                        let id = object.get("id").and_then(Value::as_str).ok_or_else(|| {
                            AutomationsError::message("Invalid automation request")
                        })?;
                        let expected = object.get("expectedRevision").and_then(Value::as_i64);
                        self.retry(id, expected)?;
                    }
                    "automation.run" => {
                        let id = object.get("id").and_then(Value::as_str).ok_or_else(|| {
                            AutomationsError::message("Invalid automation request")
                        })?;
                        let key = format!("manual:{request_id}");
                        let variables = variables(object.get("variables"))?;
                        let note = object.get("message").and_then(Value::as_str);
                        let run = self.trigger(id, &key, variables, "manual", note)?;
                        result.insert("run", run);
                    }
                    "automation.list" => {
                        let jobs = self.store.list()?;
                        let runs: HashMap<String, Value> =
                            self.store.latest_runs()?.into_iter().collect();
                        let automations: Vec<Value> = jobs
                            .iter()
                            .map(|job| serialize_value(&job.automation))
                            .collect::<Result<_>>()?;
                        let schedules: Vec<Value> = jobs
                            .iter()
                            .map(|job| {
                                schedule_entry(job, self.lives.live(), runs.get(&job.automation.id))
                            })
                            .collect();
                        result.insert("automations", Value::Array(automations.into()));
                        result.insert("schedules", Value::Array(schedules.into()));
                    }
                    "automation.inbox" => {
                        let limit = object
                            .get("limit")
                            .and_then(Value::as_i64)
                            .unwrap_or(50)
                            .clamp(1, 100) as usize;
                        let before = object.get("before").and_then(Value::as_i64);
                        let automation_id = object.get("automationId").and_then(Value::as_str);
                        let finished_after = object.get("finishedAfter").and_then(Value::as_i64);
                        let (runs, next) =
                            self.inbox(limit, before, automation_id, finished_after)?;
                        let mut inbox = Map::new();
                        inbox.insert("runs", Value::Array(runs.into()));
                        inbox.insert(
                            "before",
                            next.map_or(Value::Null, |value| Value::Number(value.into())),
                        );
                        result.insert("inbox", Value::Object(inbox));
                    }
                    _ => return Err(AutomationsError::message("Invalid automation request")),
                }
                result.insert("ok", Value::Bool(true));
                Ok(result)
            })();
        match outcome {
            Ok(result) => Value::Object(result),
            Err(error) => result_error(&request_id, &error.to_string()),
        }
    }
}

fn result_error(request_id: &str, message: &str) -> Value {
    let mut result = Map::new();
    result.insert("type", Value::String("automation.result".into()));
    result.insert("requestId", Value::String(request_id.into()));
    result.insert("ok", Value::Bool(false));
    result.insert("error", Value::String(message.into()));
    Value::Object(result)
}

fn expected_revision(value: Option<&Value>) -> Result<Option<Option<i64>>> {
    match value {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(value) => value
            .as_i64()
            .map(|revision| Some(Some(revision)))
            .ok_or_else(|| AutomationsError::message("Invalid automation request")),
    }
}

fn variables(value: Option<&Value>) -> Result<BTreeMap<String, String>> {
    let Some(Value::Object(object)) = value else {
        return Err(AutomationsError::message("Invalid automation request"));
    };
    let mut variables = BTreeMap::new();
    for (key, value) in object.iter() {
        let Some(value) = value.as_str() else {
            return Err(AutomationsError::message("Invalid automation request"));
        };
        variables.insert(key.to_string(), value.to_owned());
    }
    Ok(variables)
}

fn serialize_value<T: serde::Serialize>(value: &T) -> Result<Value> {
    let text = ace_json::ser::to_string(value)
        .map_err(|error| AutomationsError::message(error.to_string()))?;
    ace_json::parse(&text).map_err(|error| AutomationsError::message(error.to_string()))
}

fn schedule_entry(job: &JobMetadata, live: bool, last_run: Option<&Value>) -> Value {
    let mut entry = Map::new();
    entry.insert("id", Value::String(job.automation.id.as_str().into()));
    entry.insert(
        "nextRunAt",
        if live {
            job.due.map_or(Value::Null, |due| Value::Number(due.into()))
        } else {
            Value::Null
        },
    );
    entry.insert("revision", Value::Number(job.revision.into()));
    if let Some(error) = &job.last_poll_error {
        entry.insert("lastPollError", error.clone());
    }
    if let Some(error) = &job.trigger_error {
        let mut body = Map::new();
        body.insert("message", Value::String(error.message.as_str().into()));
        body.insert("at", Value::Number(error.at.into()));
        entry.insert("triggerError", Value::Object(body));
    }
    if let Some(run) = last_run {
        entry.insert("lastRun", run.clone());
    }
    Value::Object(entry)
}
