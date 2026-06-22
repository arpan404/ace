use crate::{
    PersistenceError,
    json::{decode_json, json},
    migration::{migrate, open_event_store},
};
use ace_runtime::provider::{NormalizedServerRequest, ProviderEvent};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderEventRecord {
    pub sequence: i64,
    pub provider: String,
    pub event: ProviderEvent,
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
                "INSERT INTO provider_events(provider, event_json)
                 VALUES (?1, ?2)
                 RETURNING sequence, created_at",
            )?;
            let mut server_request_statement = transaction.prepare(
                "INSERT INTO provider_server_requests(provider, request_id, request_json, status)
                 VALUES (?1, ?2, ?3, 'pending')
                 ON CONFLICT(provider, request_id) DO UPDATE SET
                   request_json = excluded.request_json",
            )?;
            for event in events {
                let (sequence, created_at) = statement
                    .query_row(params![provider, json(event)?], |row| {
                        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                    })?;
                if let ProviderEvent::ServerRequest { request } = event {
                    server_request_statement.execute(params![
                        provider,
                        request.request_id,
                        json(request.as_ref())?
                    ])?;
                }
                records.push(ProviderEventRecord {
                    sequence,
                    provider: provider.to_string(),
                    event: event.clone(),
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
                "SELECT sequence, provider, event_json, created_at
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
                "SELECT sequence, provider, event_json, created_at
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
        created_at: row.get(3)?,
    })
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
        NormalizedServerRequest, ProviderEvent, ProviderMetadata, ServerRequestKind,
    };

    #[test]
    fn appends_and_reads_recent_provider_events_in_sequence_order() {
        let mut repo =
            ProviderEventLogRepository::from_connection(Connection::open_in_memory().expect("db"))
                .expect("repo");
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

        let all = repo.recent(None, 2).expect("recent all");
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].provider, "codex");
        assert_eq!(all[1].provider, "ace");
        assert!(repo.recent(None, 0).expect("zero").is_empty());
    }

    #[test]
    fn projects_provider_server_requests_and_records_audited_decisions() {
        let mut repo =
            ProviderEventLogRepository::from_connection(Connection::open_in_memory().expect("db"))
                .expect("repo");
        repo.append_batch(
            "codex",
            &[ProviderEvent::ServerRequest {
                request: Box::new(NormalizedServerRequest {
                    kind: ServerRequestKind::CommandApproval,
                    request_id: "42".to_string(),
                    method: "command/approvalRequest".to_string(),
                    thread_id: Some("thread-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    item_id: Some("item-1".to_string()),
                    scope: Some("command".to_string()),
                    title: Some("Approve command execution".to_string()),
                    prompt: Some("Run tests?".to_string()),
                    selected_policy: Some("on-request".to_string()),
                    metadata: serde_json::json!({ "command": "cargo test" }),
                    provider: ProviderMetadata {
                        provider: "codex".to_string(),
                        method: Some("command/approvalRequest".to_string()),
                        schema_version: None,
                        raw_payload: serde_json::json!({ "command": "cargo test" }),
                    },
                }),
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
    }
}
