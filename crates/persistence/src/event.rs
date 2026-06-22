use crate::{
    PersistenceError,
    json::{decode_json, json},
    migration::{migrate, open_event_store},
};
use ace_runtime::provider::ProviderEvent;
use rusqlite::{Connection, params};

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderEventRecord {
    pub sequence: i64,
    pub provider: String,
    pub event: ProviderEvent,
    pub created_at: String,
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
            for event in events {
                let (sequence, created_at) = statement
                    .query_row(params![provider, json(event)?], |row| {
                        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                    })?;
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

fn decode_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProviderEventRecord> {
    Ok(ProviderEventRecord {
        sequence: row.get(0)?,
        provider: row.get(1)?,
        event: decode_json::<ProviderEvent>(row.get::<_, String>(2)?)?,
        created_at: row.get(3)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ace_runtime::provider::ProviderEvent;

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
}
