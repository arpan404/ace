//! The person's endpoints and the models they saved on them (ADR 0126), plus small settings.
//! Never keys: those stay in the OS keychain (ADR 0119).

use rusqlite::{OptionalExtension, params};

use crate::{Result, Store, StoreError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredEndpoint {
    pub id: String,
    pub name: String,
    /// `openai-chat`, `openai-responses` or `anthropic`.
    pub format: String,
    pub base_url: String,
    /// Extra headers sent on every call, in order.
    pub headers: Vec<(String, String)>,
    pub session_header: Option<String>,
    pub needs_key: bool,
    /// The environment variable that may hold the key (from a preset).
    pub key_env: Option<String>,
    /// The shipped preset it was made from: its models and their facts are inherited from the
    /// binary at read time, so shipped corrections reach it.
    pub preset: Option<String>,
    pub created_ms: i64,
    pub models: Vec<StoredModel>,
}

/// A model the person saved. Missing facts are filled at read time from presets or defaults.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredModel {
    pub id: String,
    pub name: Option<String>,
    pub context: Option<u64>,
    pub capabilities: Option<Vec<String>>,
    /// `listed`, `typed` or `preset`.
    pub source: String,
}

fn headers_json(headers: &[(String, String)]) -> String {
    serde_json::Value::Array(
        headers
            .iter()
            .map(|(k, v)| serde_json::json!([k, v]))
            .collect(),
    )
    .to_string()
}

fn headers_from(text: &str) -> Vec<(String, String)> {
    serde_json::from_str::<Vec<(String, String)>>(text).unwrap_or_default()
}

impl Store {
    /// Every endpoint with its saved models, oldest first.
    pub fn endpoints(&self) -> Result<Vec<StoredEndpoint>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id, name, format, base_url, headers, session_header, needs_key, key_env,
                    created_ms, preset
             FROM endpoints ORDER BY created_ms, id",
        )?;
        let mut endpoints = statement
            .query_map([], |row| {
                Ok(StoredEndpoint {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    format: row.get(2)?,
                    base_url: row.get(3)?,
                    headers: headers_from(&row.get::<_, String>(4)?),
                    session_header: row.get(5)?,
                    needs_key: row.get(6)?,
                    key_env: row.get(7)?,
                    created_ms: row.get(8)?,
                    preset: row.get(9)?,
                    models: Vec::new(),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut statement = connection.prepare(
            "SELECT endpoint_id, id, name, context, capabilities, source FROM models
             ORDER BY endpoint_id, id",
        )?;
        let rows = statement.query_map([], |row| {
            let capabilities: Option<String> = row.get(4)?;
            let context: Option<i64> = row.get(3)?;
            Ok((
                row.get::<_, String>(0)?,
                StoredModel {
                    id: row.get(1)?,
                    name: row.get(2)?,
                    context: context.and_then(|c| u64::try_from(c).ok()),
                    capabilities: capabilities.and_then(|c| serde_json::from_str(&c).ok()),
                    source: row.get(5)?,
                },
            ))
        })?;
        for row in rows {
            let (endpoint, model) = row?;
            if let Some(e) = endpoints.iter_mut().find(|e| e.id == endpoint) {
                e.models.push(model);
            }
        }
        Ok(endpoints)
    }

    /// Adds an endpoint and its models; refused if the id is taken.
    pub fn insert_endpoint(&self, endpoint: &StoredEndpoint) -> Result<()> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO endpoints
             (id, name, format, base_url, headers, session_header, needs_key, key_env, created_ms,
              preset)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                endpoint.id,
                endpoint.name,
                endpoint.format,
                endpoint.base_url,
                headers_json(&endpoint.headers),
                endpoint.session_header,
                endpoint.needs_key,
                endpoint.key_env,
                endpoint.created_ms,
                endpoint.preset
            ],
        )?;
        if inserted == 0 {
            return Err(StoreError::Exists(endpoint.id.clone()));
        }
        for model in &endpoint.models {
            put_model_in(&tx, &endpoint.id, model)?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Changes an endpoint's settings (not its id or models). Returns whether it exists.
    pub fn update_endpoint(&self, endpoint: &StoredEndpoint) -> Result<bool> {
        let changed = self.lock()?.execute(
            "UPDATE endpoints SET name = ?2, format = ?3, base_url = ?4, headers = ?5,
                    session_header = ?6, needs_key = ?7, key_env = ?8
             WHERE id = ?1",
            params![
                endpoint.id,
                endpoint.name,
                endpoint.format,
                endpoint.base_url,
                headers_json(&endpoint.headers),
                endpoint.session_header,
                endpoint.needs_key,
                endpoint.key_env
            ],
        )?;
        Ok(changed > 0)
    }

    /// Deletes an endpoint and its saved models. Returns whether it existed.
    pub fn delete_endpoint(&self, id: &str) -> Result<bool> {
        let changed = self
            .lock()?
            .execute("DELETE FROM endpoints WHERE id = ?1", params![id])?;
        Ok(changed > 0)
    }

    /// Saves or replaces a model on `endpoint`. Returns whether the endpoint exists.
    pub fn put_model(&self, endpoint: &str, model: &StoredModel) -> Result<bool> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let exists = tx
            .query_row(
                "SELECT 1 FROM endpoints WHERE id = ?1",
                params![endpoint],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !exists {
            return Ok(false);
        }
        put_model_in(&tx, endpoint, model)?;
        tx.commit()?;
        Ok(true)
    }

    /// Forgets a saved model. Returns whether it was saved.
    pub fn delete_model(&self, endpoint: &str, id: &str) -> Result<bool> {
        let changed = self.lock()?.execute(
            "DELETE FROM models WHERE endpoint_id = ?1 AND id = ?2",
            params![endpoint, id],
        )?;
        Ok(changed > 0)
    }

    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .lock()?
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Sets `key`, or clears it with `None`.
    pub fn set_setting(&self, key: &str, value: Option<&str>) -> Result<()> {
        let connection = self.lock()?;
        match value {
            Some(value) => connection.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )?,
            None => connection.execute("DELETE FROM settings WHERE key = ?1", params![key])?,
        };
        Ok(())
    }
}

fn put_model_in(tx: &rusqlite::Transaction<'_>, endpoint: &str, model: &StoredModel) -> Result<()> {
    let context = model.context.map(|c| i64::try_from(c).unwrap_or(i64::MAX));
    let capabilities = model
        .capabilities
        .as_ref()
        .map(|c| serde_json::Value::from(c.clone()).to_string());
    tx.execute(
        "INSERT INTO models (endpoint_id, id, name, context, capabilities, source)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (endpoint_id, id) DO UPDATE SET name = excluded.name,
             context = excluded.context, capabilities = excluded.capabilities,
             source = excluded.source",
        params![
            endpoint,
            model.id,
            model.name,
            context,
            capabilities,
            model.source
        ],
    )?;
    Ok(())
}
