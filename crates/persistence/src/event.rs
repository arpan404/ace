use crate::{
    PersistenceError,
    json::{decode_json, json},
    migration::{migrate, open_event_store},
};
use ace_protocol::provider_runtime::{
    ProviderRuntimeEvent, ProviderRuntimeProjectionDelta, projection_deltas_for_events,
};
use ace_runtime::{
    provider::{NormalizedServerRequest, ProviderEvent},
    threads::{AgentRuntimeSnapshot, AgentRuntimeState},
};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderEventRecord {
    pub sequence: i64,
    pub provider: String,
    pub event: ProviderEvent,
    pub projection_deltas: Vec<ProviderRuntimeProjectionDelta>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderServerRequestStatus {
    Pending,
    Resolved,
}

impl ProviderServerRequestStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Resolved => "resolved",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderServerRequestDecision {
    pub outcome: String,
    #[serde(default)]
    pub payload: Value,
    #[serde(default)]
    pub audit: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderServerRequestRecord {
    pub provider: String,
    pub request_id: String,
    pub request: Option<NormalizedServerRequest>,
    pub status: ProviderServerRequestStatus,
    pub decision: Option<ProviderServerRequestDecision>,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

#[derive(Debug)]
pub struct ProviderEventLogRepository {
    connection: Connection,
}

impl ProviderEventLogRepository {
    pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self, PersistenceError> {
        Ok(Self {
            connection: open_event_store(path)?,
        })
    }

    pub fn from_connection(connection: Connection) -> Result<Self, PersistenceError> {
        connection.pragma_update(None, "journal_mode", "WAL")?;
        migrate(&connection)?;
        Ok(Self { connection })
    }

    pub fn append_batch(
        &mut self,
        provider: &str,
        events: &[ProviderEvent],
    ) -> Result<Vec<ProviderEventRecord>, PersistenceError> {
        if events.is_empty() {
            return Ok(Vec::new());
        }

        let transaction = self.connection.transaction()?;
        let mut records = Vec::with_capacity(events.len());
        {
            let mut statement = transaction.prepare(
                "INSERT INTO provider_events(provider, event_json, projection_deltas_json)
                 VALUES (?1, ?2, ?3)
                 RETURNING sequence, created_at",
            )?;
            let mut server_request_statement = transaction.prepare(
                "INSERT INTO provider_server_requests(provider, request_id, request_json, status)
                 VALUES (?1, ?2, ?3, 'pending')
                 ON CONFLICT(provider, request_id) DO UPDATE SET
                   request_json = excluded.request_json",
            )?;
            let mut server_request_resolved_statement = transaction.prepare(
                "INSERT INTO provider_server_requests(
                   provider, request_id, request_json, status, decision_json, resolved_at
                 )
                 VALUES (?1, ?2, ?3, 'resolved', ?4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                 ON CONFLICT(provider, request_id) DO UPDATE SET
                   request_json = COALESCE(excluded.request_json, provider_server_requests.request_json),
                   status = 'resolved',
                   decision_json = excluded.decision_json,
                   resolved_at = excluded.resolved_at",
            )?;
            for event in events {
                let projection_deltas = projection_deltas_for_provider_event(provider, event);
                let (sequence, created_at) = statement.query_row(
                    params![provider, json(event)?, json(&projection_deltas)?],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                )?;
                if let ProviderEvent::ServerRequest { request } = event {
                    server_request_statement.execute(params![
                        provider,
                        request.request_id,
                        json(request.as_ref())?
                    ])?;
                }
                if let ProviderEvent::ServerRequestResolved {
                    request_id,
                    decision,
                    request,
                } = event
                {
                    server_request_resolved_statement.execute(params![
                        provider,
                        request_id,
                        request
                            .as_ref()
                            .map(|request| json(request.as_ref()))
                            .transpose()?,
                        json(decision)?
                    ])?;
                }
                records.push(ProviderEventRecord {
                    sequence,
                    provider: provider.to_string(),
                    event: event.clone(),
                    projection_deltas,
                    created_at,
                });
            }
        }
        transaction.commit()?;
        Ok(records)
    }

    pub fn record_server_request_result(
        &self,
        provider: &str,
        request_id: impl ToString,
        result: Value,
        audit: Value,
    ) -> Result<(), PersistenceError> {
        self.record_server_request_decision(
            provider,
            request_id,
            ProviderServerRequestDecision {
                outcome: "result".to_string(),
                payload: result,
                audit,
            },
        )
    }

    pub fn record_server_request_error(
        &self,
        provider: &str,
        request_id: impl ToString,
        error: Value,
        audit: Value,
    ) -> Result<(), PersistenceError> {
        self.record_server_request_decision(
            provider,
            request_id,
            ProviderServerRequestDecision {
                outcome: "error".to_string(),
                payload: error,
                audit,
            },
        )
    }

    fn record_server_request_decision(
        &self,
        provider: &str,
        request_id: impl ToString,
        decision: ProviderServerRequestDecision,
    ) -> Result<(), PersistenceError> {
        self.connection.execute(
            "INSERT INTO provider_server_requests(
               provider, request_id, request_json, status, decision_json, resolved_at
             )
             VALUES (?1, ?2, NULL, 'resolved', ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT(provider, request_id) DO UPDATE SET
               status = 'resolved',
               decision_json = excluded.decision_json,
               resolved_at = excluded.resolved_at",
            params![provider, request_id.to_string(), json(&decision)?],
        )?;
        Ok(())
    }

    pub fn server_requests(
        &self,
        provider: Option<&str>,
        status: Option<ProviderServerRequestStatus>,
        limit: usize,
    ) -> Result<Vec<ProviderServerRequestRecord>, PersistenceError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let capped_limit = i64::try_from(limit.min(1_000)).unwrap_or(1_000);
        match (provider, status) {
            (Some(provider), Some(status)) => {
                let mut statement = self.connection.prepare(
                    "SELECT provider, request_id, request_json, status, decision_json, created_at, resolved_at
                     FROM provider_server_requests
                     WHERE provider = ?1 AND status = ?2
                     ORDER BY created_at DESC
                     LIMIT ?3",
                )?;
                collect_server_requests(statement.query_map(
                    params![provider, status.as_str(), capped_limit],
                    decode_server_request_record,
                )?)
            }
            (Some(provider), None) => {
                let mut statement = self.connection.prepare(
                    "SELECT provider, request_id, request_json, status, decision_json, created_at, resolved_at
                     FROM provider_server_requests
                     WHERE provider = ?1
                     ORDER BY created_at DESC
                     LIMIT ?2",
                )?;
                collect_server_requests(statement.query_map(
                    params![provider, capped_limit],
                    decode_server_request_record,
                )?)
            }
            (None, Some(status)) => {
                let mut statement = self.connection.prepare(
                    "SELECT provider, request_id, request_json, status, decision_json, created_at, resolved_at
                     FROM provider_server_requests
                     WHERE status = ?1
                     ORDER BY created_at DESC
                     LIMIT ?2",
                )?;
                collect_server_requests(statement.query_map(
                    params![status.as_str(), capped_limit],
                    decode_server_request_record,
                )?)
            }
            (None, None) => {
                let mut statement = self.connection.prepare(
                    "SELECT provider, request_id, request_json, status, decision_json, created_at, resolved_at
                     FROM provider_server_requests
                     ORDER BY created_at DESC
                     LIMIT ?1",
                )?;
                collect_server_requests(
                    statement.query_map(params![capped_limit], decode_server_request_record)?,
                )
            }
        }
    }

    pub fn server_request(
        &self,
        provider: &str,
        request_id: &str,
    ) -> Result<Option<ProviderServerRequestRecord>, PersistenceError> {
        let mut statement = self.connection.prepare(
            "SELECT provider, request_id, request_json, status, decision_json, created_at, resolved_at
             FROM provider_server_requests
             WHERE provider = ?1 AND request_id = ?2
             LIMIT 1",
        )?;
        let mut rows =
            statement.query_map(params![provider, request_id], decode_server_request_record)?;
        rows.next()
            .map(|row| row.map_err(PersistenceError::from))
            .transpose()
    }

    pub fn recent(
        &self,
        provider: Option<&str>,
        limit: usize,
    ) -> Result<Vec<ProviderEventRecord>, PersistenceError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let capped_limit = i64::try_from(limit.min(1_000)).unwrap_or(1_000);
        let mut records = if let Some(provider) = provider {
            let mut statement = self.connection.prepare(
                "SELECT sequence, provider, event_json, projection_deltas_json, created_at
                 FROM provider_events
                 WHERE provider = ?1
                 ORDER BY sequence DESC
                 LIMIT ?2",
            )?;
            statement
                .query_map(params![provider, capped_limit], decode_record)?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            let mut statement = self.connection.prepare(
                "SELECT sequence, provider, event_json, projection_deltas_json, created_at
                 FROM provider_events
                 ORDER BY sequence DESC
                 LIMIT ?1",
            )?;
            statement
                .query_map(params![capped_limit], decode_record)?
                .collect::<Result<Vec<_>, _>>()?
        };
        records.reverse();
        Ok(records)
    }

    pub fn after_sequence(
        &self,
        provider: Option<&str>,
        sequence: i64,
        limit: usize,
    ) -> Result<Vec<ProviderEventRecord>, PersistenceError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let capped_limit = i64::try_from(limit.min(1_000)).unwrap_or(1_000);
        let records = if let Some(provider) = provider {
            let mut statement = self.connection.prepare(
                "SELECT sequence, provider, event_json, projection_deltas_json, created_at
                 FROM provider_events
                 WHERE provider = ?1 AND sequence > ?2
                 ORDER BY sequence ASC
                 LIMIT ?3",
            )?;
            statement
                .query_map(params![provider, sequence, capped_limit], decode_record)?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            let mut statement = self.connection.prepare(
                "SELECT sequence, provider, event_json, projection_deltas_json, created_at
                 FROM provider_events
                 WHERE sequence > ?1
                 ORDER BY sequence ASC
                 LIMIT ?2",
            )?;
            statement
                .query_map(params![sequence, capped_limit], decode_record)?
                .collect::<Result<Vec<_>, _>>()?
        };
        Ok(records)
    }

    pub fn recent_or_after_sequence(
        &self,
        provider: Option<&str>,
        sequence: Option<i64>,
        limit: usize,
    ) -> Result<Vec<ProviderEventRecord>, PersistenceError> {
        match sequence {
            Some(sequence) => self.after_sequence(provider, sequence, limit),
            None => self.recent(provider, limit),
        }
    }

    pub fn runtime_state_snapshot(
        &self,
        provider: Option<&str>,
    ) -> Result<AgentRuntimeSnapshot, PersistenceError> {
        let mut state = AgentRuntimeState::default();
        let mut statement = if provider.is_some() {
            self.connection.prepare(
                "SELECT sequence, provider, event_json, projection_deltas_json, created_at
                 FROM provider_events
                 WHERE provider = ?1
                 ORDER BY sequence ASC",
            )?
        } else {
            self.connection.prepare(
                "SELECT sequence, provider, event_json, projection_deltas_json, created_at
                 FROM provider_events
                 ORDER BY sequence ASC",
            )?
        };
        if let Some(provider) = provider {
            let records = statement.query_map(params![provider], decode_record)?;
            for record in records {
                state.apply_provider_events(&[record?.event]);
            }
        } else {
            let records = statement.query_map([], decode_record)?;
            for record in records {
                state.apply_provider_events(&[record?.event]);
            }
        }
        Ok(state.snapshot())
    }

    pub fn has_provider_events(&self, provider: &str) -> Result<bool, PersistenceError> {
        let count = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM provider_events WHERE provider = ?1 LIMIT 1)",
            params![provider],
            |row| row.get::<_, i64>(0),
        )?;
        Ok(count != 0)
    }

    pub fn last_provider_event_sequence(
        &self,
        provider: &str,
    ) -> Result<Option<i64>, PersistenceError> {
        let sequence = self.connection.query_row(
            "SELECT MAX(sequence) FROM provider_events WHERE provider = ?1",
            params![provider],
            |row| row.get::<_, Option<i64>>(0),
        )?;
        Ok(sequence)
    }
}

fn collect_server_requests<I>(rows: I) -> Result<Vec<ProviderServerRequestRecord>, PersistenceError>
where
    I: Iterator<Item = rusqlite::Result<ProviderServerRequestRecord>>,
{
    let mut records = rows
        .map(|row| row.map_err(PersistenceError::from))
        .collect::<Result<Vec<_>, _>>()?;
    records.reverse();
    Ok(records)
}

fn decode_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProviderEventRecord> {
    Ok(ProviderEventRecord {
        sequence: row.get(0)?,
        provider: row.get(1)?,
        event: decode_json::<ProviderEvent>(row.get::<_, String>(2)?)?,
        projection_deltas: decode_json::<Vec<ProviderRuntimeProjectionDelta>>(
            row.get::<_, String>(3)?,
        )?,
        created_at: row.get(4)?,
    })
}

fn projection_deltas_for_provider_event(
    provider: &str,
    event: &ProviderEvent,
) -> Vec<ProviderRuntimeProjectionDelta> {
    projection_deltas_for_events(&[ProviderRuntimeEvent::from_provider_event(
        provider,
        event.clone(),
    )])
}

fn decode_server_request_record(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ProviderServerRequestRecord> {
    let status = match row.get::<_, String>(3)?.as_str() {
        "pending" => ProviderServerRequestStatus::Pending,
        "resolved" => ProviderServerRequestStatus::Resolved,
        value => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                format!("unknown provider server request status `{value}`").into(),
            ));
        }
    };
    let request_json = row.get::<_, Option<String>>(2)?;
    let decision_json = row.get::<_, Option<String>>(4)?;
    Ok(ProviderServerRequestRecord {
        provider: row.get(0)?,
        request_id: row.get(1)?,
        request: request_json
            .map(decode_json::<NormalizedServerRequest>)
            .transpose()?,
        status,
        decision: decision_json
            .map(decode_json::<ProviderServerRequestDecision>)
            .transpose()?,
        created_at: row.get(5)?,
        resolved_at: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ace_runtime::provider::{
        NormalizedRuntimeSignal, NormalizedServerRequest, NormalizedServerRequestDecision,
        NormalizedThreadItem, ProviderEvent, ProviderMetadata, RuntimeSignalKind,
        ServerRequestKind, ThreadItemKind, ThreadItemStatus,
    };
    use ace_runtime::threads::ChildThreadRelationship;
    use ace_runtime::tools::{
        ProviderToolMetadata, SemanticToolCall, ToolActionKind, ToolDisplay, ToolRunStatus,
        ToolSurface, ToolTarget, ToolTargetKind, ToolTransport,
    };

    #[test]
    fn appends_and_reads_recent_provider_events_in_sequence_order() {
        let mut repo =
            ProviderEventLogRepository::from_connection(Connection::open_in_memory().expect("db"))
                .expect("repo");
        assert!(!repo.has_provider_events("codex").expect("empty codex"));
        let first = repo
            .append_batch(
                "codex",
                &[
                    ProviderEvent::StderrLine {
                        line: "one".to_string(),
                    },
                    ProviderEvent::RawNotification {
                        method: "item/completed".to_string(),
                        params: serde_json::json!({ "item": "a" }),
                    },
                ],
            )
            .expect("append");
        assert_eq!(first.len(), 2);
        assert!(first[0].sequence < first[1].sequence);

        repo.append_batch(
            "ace",
            &[ProviderEvent::StderrLine {
                line: "ignored".to_string(),
            }],
        )
        .expect("append ace");

        let codex = repo.recent(Some("codex"), 10).expect("recent codex");
        assert_eq!(codex.len(), 2);
        assert_eq!(codex[0].sequence, first[0].sequence);
        assert_eq!(codex[1].sequence, first[1].sequence);
        let first_delta = serde_json::to_value(&codex[0].projection_deltas[0]).expect("delta");
        let second_delta = serde_json::to_value(&codex[1].projection_deltas[0]).expect("delta");
        assert_eq!(first_delta["type"], "stderr_appended");
        assert_eq!(second_delta["type"], "raw_notification_observed");
        assert!(repo.has_provider_events("codex").expect("codex events"));
        assert!(repo.has_provider_events("ace").expect("ace events"));
        assert!(!repo.has_provider_events("missing").expect("missing events"));
        assert_eq!(
            repo.last_provider_event_sequence("codex")
                .expect("codex last sequence"),
            Some(first[1].sequence)
        );
        assert_eq!(
            repo.last_provider_event_sequence("missing")
                .expect("missing last sequence"),
            None
        );

        let all = repo.recent(None, 2).expect("recent all");
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].provider, "codex");
        assert_eq!(all[1].provider, "ace");
        let after_first_codex = repo
            .after_sequence(Some("codex"), first[0].sequence, 10)
            .expect("after first codex");
        assert_eq!(after_first_codex.len(), 1);
        assert_eq!(after_first_codex[0].sequence, first[1].sequence);
        let after_all = repo
            .after_sequence(None, first[0].sequence, 10)
            .expect("after first all");
        assert_eq!(after_all.len(), 2);
        assert_eq!(after_all[0].provider, "codex");
        assert_eq!(after_all[1].provider, "ace");
        let after_missing = repo
            .recent_or_after_sequence(Some("codex"), Some(first[1].sequence), 10)
            .expect("after last codex");
        assert!(after_missing.is_empty());
        assert!(repo.recent(None, 0).expect("zero").is_empty());
        assert!(
            repo.after_sequence(None, first[0].sequence, 0)
                .expect("zero after")
                .is_empty()
        );
    }

    #[test]
    fn migrates_old_provider_events_and_persists_projection_deltas_for_new_events() {
        let connection = Connection::open_in_memory().expect("db");
        connection
            .execute_batch(
                "
                CREATE TABLE provider_events (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    provider TEXT NOT NULL,
                    event_json TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                );
                INSERT INTO provider_events(provider, event_json)
                VALUES ('codex', '{\"type\":\"stderr_line\",\"line\":\"old\"}');
                ",
            )
            .expect("old schema");
        let mut repo = ProviderEventLogRepository::from_connection(connection).expect("repo");
        let migrated = repo.recent(Some("codex"), 10).expect("migrated events");
        assert_eq!(migrated.len(), 1);
        assert!(
            migrated[0].projection_deltas.is_empty(),
            "old rows should get a bounded empty default without replay migration work"
        );

        repo.append_batch(
            "codex",
            &[ProviderEvent::StderrLine {
                line: "new".to_string(),
            }],
        )
        .expect("append");
        let records = repo.recent(Some("codex"), 10).expect("events");
        assert_eq!(records.len(), 2);
        let delta = serde_json::to_value(&records[1].projection_deltas[0]).expect("delta");
        assert_eq!(delta["type"], "stderr_appended");
        assert_eq!(delta["line"], "new");
    }

    #[test]
    fn replays_provider_events_into_runtime_state_snapshot() {
        let mut repo =
            ProviderEventLogRepository::from_connection(Connection::open_in_memory().expect("db"))
                .expect("repo");
        repo.append_batch(
            "codex",
            &[
                ProviderEvent::ThreadItem {
                    item: Box::new(thread_item("item-1", "draft")),
                },
                ProviderEvent::ThreadItem {
                    item: Box::new(thread_item("item-1", "final")),
                },
                ProviderEvent::ThreadItem {
                    item: Box::new(NormalizedThreadItem {
                        kind: ThreadItemKind::Plan,
                        status: ThreadItemStatus::Updated,
                        thread_id: Some("thread-1".to_string()),
                        turn_id: Some("turn-1".to_string()),
                        item_id: Some("plan-1".to_string()),
                        parent_thread_id: None,
                        child_thread_id: None,
                        sender: None,
                        role: None,
                        title: None,
                        text: Some("Plan text".to_string()),
                        status_text: None,
                        model: None,
                        target: None,
                        url: None,
                        files: None,
                        attachments: None,
                        diff: None,
                        token_usage: None,
                        plan_questions: Some(serde_json::json!([{ "id": "choice" }])),
                        plan_completion: Some("complete".to_string()),
                        metadata: serde_json::json!({}),
                        provider: ProviderMetadata {
                            provider: "codex".to_string(),
                            method: Some("item/plan/delta".to_string()),
                            schema_version: None,
                            raw_payload: serde_json::json!({ "plan": true }),
                        },
                    }),
                },
                ProviderEvent::ThreadItem {
                    item: Box::new(NormalizedThreadItem {
                        kind: ThreadItemKind::SubAgentActivity,
                        status: ThreadItemStatus::Started,
                        thread_id: Some("thread-1".to_string()),
                        turn_id: Some("turn-1".to_string()),
                        item_id: Some("subagent-item-1".to_string()),
                        parent_thread_id: Some("thread-1".to_string()),
                        child_thread_id: Some("subagent-1".to_string()),
                        sender: Some("reviewer".to_string()),
                        role: Some("reviewer".to_string()),
                        title: None,
                        text: None,
                        status_text: None,
                        model: None,
                        target: None,
                        url: None,
                        files: None,
                        attachments: None,
                        diff: None,
                        token_usage: None,
                        plan_questions: None,
                        plan_completion: None,
                        metadata: serde_json::json!({ "phase": "started" }),
                        provider: ProviderMetadata {
                            provider: "codex".to_string(),
                            method: Some("item/started".to_string()),
                            schema_version: None,
                            raw_payload: serde_json::json!({ "subagent": true }),
                        },
                    }),
                },
                ProviderEvent::SemanticTool {
                    tool: Box::new(semantic_tool(
                        "tool-1",
                        ToolRunStatus::Started,
                        "Ran cargo test",
                    )),
                },
                ProviderEvent::SemanticTool {
                    tool: Box::new(terminal_output_tool("tool-1", "proc-1", "running tests\n")),
                },
                realtime_signal(
                    RuntimeSignalKind::RealtimeTranscriptDelta,
                    "turn-1",
                    "hello ",
                ),
                realtime_signal(
                    RuntimeSignalKind::RealtimeTranscriptDelta,
                    "turn-1",
                    "world",
                ),
                realtime_signal(RuntimeSignalKind::RealtimeAudioDelta, "turn-1", "audio-1"),
                ProviderEvent::RuntimeSignal {
                    signal: Box::new(NormalizedRuntimeSignal {
                        kind: RuntimeSignalKind::ProviderStateUpdated,
                        thread_id: None,
                        turn_id: None,
                        item_id: None,
                        message: None,
                        from_model: None,
                        to_model: None,
                        reason: None,
                        text: None,
                        audio: None,
                        status: Some("connected".to_string()),
                        name: Some("Devbox".to_string()),
                        active: None,
                        archived: None,
                        diff: None,
                        files: None,
                        process_id: None,
                        exit_code: None,
                        request_id: None,
                        metadata: serde_json::json!({
                            "hostId": "devbox",
                            "host": "devbox.example.com",
                            "displayName": "Devbox",
                            "status": "connected",
                            "projects": [{ "path": "/srv/ace" }]
                        }),
                        provider: ProviderMetadata {
                            provider: "codex".to_string(),
                            method: Some("remoteControl/status/changed".to_string()),
                            schema_version: None,
                            raw_payload: serde_json::json!({
                                "hostId": "devbox",
                                "host": "devbox.example.com",
                                "displayName": "Devbox",
                                "status": "connected",
                                "projects": [{ "path": "/srv/ace" }]
                            }),
                        },
                    }),
                },
                ProviderEvent::SemanticTool {
                    tool: Box::new(semantic_tool(
                        "tool-1",
                        ToolRunStatus::Completed,
                        "Completed cargo test",
                    )),
                },
                ProviderEvent::ServerRequest {
                    request: Box::new(server_request("approval-1")),
                },
                ProviderEvent::ServerRequestResolved {
                    request_id: "approval-1".to_string(),
                    decision: NormalizedServerRequestDecision {
                        outcome: "result".to_string(),
                        payload: serde_json::json!({ "approved": true }),
                        audit: serde_json::json!({
                            "source_thread_id": "thread-1",
                            "selected_policy": "on-request"
                        }),
                    },
                    request: Some(Box::new(server_request("approval-1"))),
                },
            ],
        )
        .expect("append codex");
        repo.append_batch(
            "other",
            &[ProviderEvent::ThreadItem {
                item: Box::new(NormalizedThreadItem {
                    provider: ProviderMetadata {
                        provider: "other".to_string(),
                        method: Some("item/completed".to_string()),
                        schema_version: None,
                        raw_payload: serde_json::json!({ "ignored": false }),
                    },
                    ..thread_item("other-item", "other")
                }),
            }],
        )
        .expect("append other");

        let codex = repo
            .runtime_state_snapshot(Some("codex"))
            .expect("codex snapshot");
        assert_eq!(codex.thread_items.len(), 3);
        assert_eq!(codex.thread_items[0].item_id.as_deref(), Some("item-1"));
        assert_eq!(codex.thread_items[0].text.as_deref(), Some("final"));
        assert_eq!(codex.thread_items[0].provider.raw_payload["text"], "final");
        assert_eq!(codex.plan_sessions.len(), 1);
        assert_eq!(codex.plan_sessions[0].item_id.as_deref(), Some("plan-1"));
        assert_eq!(
            codex.plan_sessions[0]
                .questions
                .as_ref()
                .expect("questions")[0]["id"],
            "choice"
        );
        assert_eq!(codex.approvals.len(), 1);
        assert_eq!(codex.approvals[0].request_id, "approval-1");
        assert_eq!(
            codex.approvals[0]
                .decision
                .as_ref()
                .expect("decision")
                .audit["selected_policy"],
            "on-request"
        );
        assert_eq!(codex.child_threads.len(), 1);
        assert_eq!(codex.child_threads[0].parent_thread_id, "thread-1");
        assert_eq!(codex.child_threads[0].thread_id, "subagent-1");
        assert_eq!(
            codex.child_threads[0].relationship,
            ChildThreadRelationship::Subagent
        );
        assert_eq!(codex.child_threads[0].role.as_deref(), Some("reviewer"));
        assert_eq!(codex.tool_timeline.len(), 1);
        assert_eq!(
            codex.tool_timeline[0].provider.item_id.as_deref(),
            Some("tool-1")
        );
        assert_eq!(
            codex.tool_timeline[0].display.status,
            ToolRunStatus::Completed
        );
        assert_eq!(codex.tool_timeline[0].display.title, "Completed cargo test");
        assert_eq!(codex.terminal_outputs.len(), 1);
        assert_eq!(codex.terminal_outputs[0].item_id.as_deref(), Some("tool-1"));
        assert_eq!(
            codex.terminal_outputs[0].process_id.as_deref(),
            Some("proc-1")
        );
        assert_eq!(codex.terminal_outputs[0].text, "running tests\n");
        assert_eq!(codex.realtime_transcripts.len(), 1);
        assert_eq!(codex.realtime_transcripts[0].text, "hello world");
        assert_eq!(codex.realtime_audio.len(), 1);
        assert_eq!(codex.realtime_audio[0].chunks, vec!["audio-1".to_string()]);
        assert_eq!(codex.remote_connections.len(), 1);
        assert_eq!(codex.remote_connections[0].host_id, "devbox");
        assert_eq!(
            codex.remote_connections[0].host.as_deref(),
            Some("devbox.example.com")
        );
        assert_eq!(
            codex.remote_connections[0].status.as_deref(),
            Some("connected")
        );
        assert_eq!(codex.remote_connections[0].projects[0]["path"], "/srv/ace");

        let all = repo.runtime_state_snapshot(None).expect("all snapshot");
        assert_eq!(all.thread_items.len(), 4);
        assert!(
            all.thread_items
                .iter()
                .any(|item| item.provider.provider == "other")
        );
    }

    #[test]
    fn projects_provider_server_requests_and_records_audited_decisions() {
        let mut repo =
            ProviderEventLogRepository::from_connection(Connection::open_in_memory().expect("db"))
                .expect("repo");
        let server_request = |request_id: &str, prompt: &str| NormalizedServerRequest {
            kind: ServerRequestKind::CommandApproval,
            request_id: request_id.to_string(),
            method: "command/approvalRequest".to_string(),
            thread_id: Some("thread-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            item_id: Some(format!("item-{request_id}")),
            scope: Some("command".to_string()),
            title: Some("Approve command execution".to_string()),
            prompt: Some(prompt.to_string()),
            selected_policy: Some("on-request".to_string()),
            detail: Default::default(),
            metadata: serde_json::json!({ "command": "cargo test" }),
            provider: ProviderMetadata {
                provider: "codex".to_string(),
                method: Some("command/approvalRequest".to_string()),
                schema_version: None,
                raw_payload: serde_json::json!({ "command": "cargo test" }),
            },
        };
        repo.append_batch(
            "codex",
            &[ProviderEvent::ServerRequest {
                request: Box::new(server_request("42", "Run tests?")),
            }],
        )
        .expect("append server request");

        let pending = repo
            .server_requests(
                Some("codex"),
                Some(ProviderServerRequestStatus::Pending),
                10,
            )
            .expect("pending");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].request_id, "42");
        let pending_by_id = repo
            .server_request("codex", "42")
            .expect("pending by id")
            .expect("pending record");
        assert_eq!(
            pending_by_id
                .request
                .as_ref()
                .expect("request")
                .scope
                .as_deref(),
            Some("command")
        );
        assert_eq!(
            pending[0]
                .request
                .as_ref()
                .expect("request")
                .prompt
                .as_deref(),
            Some("Run tests?")
        );
        assert!(pending[0].decision.is_none());

        repo.record_server_request_result(
            "codex",
            42,
            serde_json::json!({ "approved": true }),
            serde_json::json!({
                "scope": "command",
                "source_thread_id": "thread-1",
                "source_item_id": "item-1",
                "prompt": "Run tests?",
                "selected_policy": "on-request",
                "decided_by": "user",
                "reason": "trusted command"
            }),
        )
        .expect("record decision");

        assert!(
            repo.server_requests(
                Some("codex"),
                Some(ProviderServerRequestStatus::Pending),
                10
            )
            .expect("pending after decision")
            .is_empty()
        );
        let resolved = repo
            .server_requests(
                Some("codex"),
                Some(ProviderServerRequestStatus::Resolved),
                10,
            )
            .expect("resolved");
        assert_eq!(resolved.len(), 1);
        let decision = resolved[0].decision.as_ref().expect("decision");
        assert_eq!(decision.outcome, "result");
        assert_eq!(decision.payload["approved"], true);
        assert_eq!(decision.audit["decided_by"], "user");
        assert_eq!(decision.audit["source_thread_id"], "thread-1");
        assert!(resolved[0].resolved_at.is_some());

        repo.append_batch(
            "codex",
            &[
                ProviderEvent::ServerRequest {
                    request: Box::new(server_request("43", "Run clippy?")),
                },
                ProviderEvent::ServerRequestResolved {
                    request_id: "43".to_string(),
                    decision: NormalizedServerRequestDecision {
                        outcome: "result".to_string(),
                        payload: serde_json::json!({ "approved": false }),
                        audit: serde_json::json!({
                            "decided_by": "codex",
                            "source_thread_id": "thread-1"
                        }),
                    },
                    request: None,
                },
            ],
        )
        .expect("append provider resolution");

        let resolved_by_notification = repo
            .server_request("codex", "43")
            .expect("resolved by notification lookup")
            .expect("resolved by notification");
        assert_eq!(
            resolved_by_notification.status,
            ProviderServerRequestStatus::Resolved
        );
        assert_eq!(
            resolved_by_notification
                .request
                .as_ref()
                .expect("request")
                .prompt
                .as_deref(),
            Some("Run clippy?")
        );
        let decision = resolved_by_notification
            .decision
            .as_ref()
            .expect("decision");
        assert_eq!(decision.outcome, "result");
        assert_eq!(decision.payload["approved"], false);
        assert_eq!(decision.audit["decided_by"], "codex");
    }

    fn thread_item(item_id: &str, text: &str) -> NormalizedThreadItem {
        NormalizedThreadItem {
            kind: ThreadItemKind::AgentMessage,
            status: ThreadItemStatus::Updated,
            thread_id: Some("thread-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            item_id: Some(item_id.to_string()),
            parent_thread_id: None,
            child_thread_id: None,
            sender: None,
            role: None,
            title: None,
            text: Some(text.to_string()),
            status_text: None,
            model: None,
            target: None,
            url: None,
            files: None,
            attachments: None,
            diff: None,
            token_usage: None,
            plan_questions: None,
            plan_completion: None,
            metadata: serde_json::json!({}),
            provider: ProviderMetadata {
                provider: "codex".to_string(),
                method: Some("item/agentMessage/delta".to_string()),
                schema_version: Some("test-v1".to_string()),
                raw_payload: serde_json::json!({
                    "itemId": item_id,
                    "text": text
                }),
            },
        }
    }

    fn server_request(request_id: &str) -> NormalizedServerRequest {
        NormalizedServerRequest {
            kind: ServerRequestKind::CommandApproval,
            request_id: request_id.to_string(),
            method: "command/approvalRequest".to_string(),
            thread_id: Some("thread-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            item_id: Some("cmd-1".to_string()),
            scope: Some("command".to_string()),
            title: Some("Approve command".to_string()),
            prompt: Some("Run cargo test?".to_string()),
            selected_policy: Some("on-request".to_string()),
            detail: Default::default(),
            metadata: serde_json::json!({ "command": "cargo test" }),
            provider: ProviderMetadata {
                provider: "codex".to_string(),
                method: Some("command/approvalRequest".to_string()),
                schema_version: Some("test-v1".to_string()),
                raw_payload: serde_json::json!({ "command": "cargo test" }),
            },
        }
    }

    fn semantic_tool(item_id: &str, status: ToolRunStatus, title: &str) -> SemanticToolCall {
        SemanticToolCall {
            transport: ToolTransport::Shell,
            surface: ToolSurface::Terminal,
            action: ToolActionKind::TerminalRun,
            display: ToolDisplay {
                title: title.to_string(),
                summary: Some("cargo test".to_string()),
                target: Some(ToolTarget {
                    kind: ToolTargetKind::Command,
                    label: "cargo test".to_string(),
                }),
                status,
                icon_key: "terminal".to_string(),
                technical_metadata: serde_json::json!({ "bounded": true }),
            },
            provider: ProviderToolMetadata {
                provider: Some("codex".to_string()),
                method: Some("command/exec".to_string()),
                item_id: Some(item_id.to_string()),
                turn_id: Some("turn-1".to_string()),
                thread_id: Some("thread-1".to_string()),
                server_name: None,
                tool_name: Some("shell".to_string()),
                operation: Some("exec".to_string()),
                raw_args: serde_json::json!({ "command": "cargo test" }),
                raw_result: serde_json::Value::Null,
                raw_payload: serde_json::json!({ "itemId": item_id, "command": "cargo test" }),
            },
        }
    }

    fn terminal_output_tool(item_id: &str, process_id: &str, delta: &str) -> SemanticToolCall {
        let mut tool = semantic_tool(item_id, ToolRunStatus::Updated, "Read terminal output");
        tool.action = ToolActionKind::TerminalOutput;
        tool.provider.operation = Some("process/outputDelta".to_string());
        tool.provider.raw_args = serde_json::json!({ "processId": process_id, "delta": delta });
        tool.provider.raw_payload = serde_json::json!({
            "item": {
                "id": item_id,
                "processId": process_id,
                "delta": delta
            }
        });
        tool
    }

    fn realtime_signal(kind: RuntimeSignalKind, turn_id: &str, payload: &str) -> ProviderEvent {
        let (method, text, audio) = match kind {
            RuntimeSignalKind::RealtimeTranscriptDelta => {
                ("realtime/transcriptDelta", Some(payload.to_string()), None)
            }
            RuntimeSignalKind::RealtimeAudioDelta => {
                ("realtime/audioDelta", None, Some(payload.to_string()))
            }
            _ => ("realtime/unknown", None, None),
        };
        ProviderEvent::RuntimeSignal {
            signal: Box::new(NormalizedRuntimeSignal {
                kind,
                thread_id: Some("thread-1".to_string()),
                turn_id: Some(turn_id.to_string()),
                item_id: None,
                message: None,
                from_model: None,
                to_model: None,
                reason: None,
                text,
                audio,
                status: None,
                name: None,
                active: None,
                archived: None,
                diff: None,
                files: None,
                process_id: None,
                exit_code: None,
                request_id: None,
                metadata: serde_json::json!({ "payload": payload }),
                provider: ProviderMetadata {
                    provider: "codex".to_string(),
                    method: Some(method.to_string()),
                    schema_version: None,
                    raw_payload: serde_json::json!({ "payload": payload }),
                },
            }),
        }
    }
}
