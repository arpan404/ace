// SPDX-License-Identifier: Apache-2.0
//! Where pairing links wait (`pairing-codes.ts`): one use each, and the daemon's own database so
//! a restart doesn't void a link someone is about to scan. Only the code's SHA-256 is stored.

use std::collections::HashMap;

use crate::devices::Scope;
use crate::error::{AuthError, Result};

use super::PendingCode;

/// Where pairing links wait. `take` is the single use: it removes the link as it returns it, so
/// one code can never pair two devices (`pairing-codes.ts:21`).
pub trait PairingCodeStore: Send {
    fn put(&mut self, code_hash: &str, pending: &PendingCode) -> Result<()>;
    fn take(&mut self, code_hash: &str) -> Result<Option<PendingCode>>;
    /// Unexpired links, oldest expiry first; expired ones are dropped on the way.
    fn pending(&mut self, now: i64) -> Result<Vec<PendingCode>>;
    fn remove(&mut self, id: &str) -> Result<bool>;
    fn clear(&mut self) -> Result<()>;
}

/// Links that last as long as the process, for embedded servers and tests (`pairing-codes.ts:31`).
#[derive(Debug, Default)]
pub struct MemoryPairingCodes {
    codes: HashMap<String, PendingCode>,
    order: Vec<String>,
}

impl MemoryPairingCodes {
    pub fn new() -> Self {
        Self::default()
    }
}

impl PairingCodeStore for MemoryPairingCodes {
    fn put(&mut self, code_hash: &str, pending: &PendingCode) -> Result<()> {
        if self
            .codes
            .insert(code_hash.to_owned(), pending.clone())
            .is_none()
        {
            self.order.push(code_hash.to_owned());
        }
        Ok(())
    }

    fn take(&mut self, code_hash: &str) -> Result<Option<PendingCode>> {
        let taken = self.codes.remove(code_hash);
        if taken.is_some() {
            self.order.retain(|key| key != code_hash);
        }
        Ok(taken)
    }

    fn pending(&mut self, now: i64) -> Result<Vec<PendingCode>> {
        let expired: Vec<String> = self
            .codes
            .iter()
            .filter(|(_, code)| code.expires_at <= now)
            .map(|(key, _)| key.clone())
            .collect();
        for key in &expired {
            self.codes.remove(key);
        }
        self.order.retain(|key| !expired.contains(key));
        let mut pending: Vec<PendingCode> = self
            .order
            .iter()
            .filter_map(|key| self.codes.get(key).cloned())
            .collect();
        // A stable sort keeps insertion order between links with the same expiry.
        pending.sort_by_key(|code| code.expires_at);
        Ok(pending)
    }

    fn remove(&mut self, id: &str) -> Result<bool> {
        let key = self
            .order
            .iter()
            .find(|key| self.codes.get(*key).is_some_and(|code| code.id == id))
            .cloned();
        match key {
            Some(key) => {
                self.codes.remove(&key);
                self.order.retain(|each| *each != key);
                Ok(true)
            }
            None => Ok(false),
        }
    }

    fn clear(&mut self) -> Result<()> {
        self.codes.clear();
        self.order.clear();
        Ok(())
    }
}

/// Links kept in the daemon's database, so a restart doesn't void one being scanned
/// (`pairing-codes.ts:85`). Only the code's SHA-256 is stored; a link still ends at its expiry.
pub struct SqlitePairingCodes {
    conn: std::sync::Arc<ace_store::Connection>,
}

impl SqlitePairingCodes {
    pub fn new(conn: std::sync::Arc<ace_store::Connection>) -> Result<Self> {
        conn.exec(
            "CREATE TABLE IF NOT EXISTS pairing_codes (\n\
             code_hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL,\n\
             scopes TEXT NOT NULL, label TEXT, device_ttl_ms INTEGER, person INTEGER)",
        )?;
        // A table from before links said who made them: a column added, no row rewritten.
        let columns = conn.prepare("SELECT name FROM pragma_table_info('pairing_codes')")?;
        let mut has_person = false;
        while let Some(values) = columns.step()? {
            if values.first().and_then(|value| match value {
                ace_store::Value::Text(text) => Some(text.as_str()),
                _ => None,
            }) == Some("person")
            {
                has_person = true;
            }
        }
        if !has_person {
            conn.exec("ALTER TABLE pairing_codes ADD COLUMN person INTEGER")?;
        }
        Ok(Self { conn })
    }

    fn all(&self, sql: &str, params: &[Option<ace_store::Value>]) -> Result<Vec<PendingCode>> {
        let statement = self.conn.prepare(sql)?;
        statement.bind(params)?;
        let mut codes = Vec::new();
        while let Some(values) = statement.step()? {
            codes.push(decode_row(&values)?);
        }
        Ok(codes)
    }
}

impl PairingCodeStore for SqlitePairingCodes {
    fn put(&mut self, code_hash: &str, pending: &PendingCode) -> Result<()> {
        let statement = self.conn.prepare(
            "INSERT INTO pairing_codes (code_hash, id, expires_at, scopes, label, device_ttl_ms, \
             person) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )?;
        statement.bind(&[
            text(code_hash),
            text(&pending.id),
            integer(pending.expires_at),
            text(&scopes_json(&pending.scopes)),
            opt_text(pending.label.as_deref()),
            opt_integer(pending.device_ttl_ms),
            integer(i64::from(pending.person)),
        ])?;
        statement.step()?;
        Ok(())
    }

    fn take(&mut self, code_hash: &str) -> Result<Option<PendingCode>> {
        let statement = self
            .conn
            .prepare("DELETE FROM pairing_codes WHERE code_hash = ? RETURNING *")?;
        statement.bind(&[text(code_hash)])?;
        match statement.step()? {
            Some(values) => Ok(Some(decode_row(&values)?)),
            None => Ok(None),
        }
    }

    fn pending(&mut self, now: i64) -> Result<Vec<PendingCode>> {
        let expired = self
            .conn
            .prepare("DELETE FROM pairing_codes WHERE expires_at <= ?")?;
        expired.bind(&[integer(now)])?;
        expired.step()?;
        self.all("SELECT * FROM pairing_codes ORDER BY expires_at, id", &[])
    }

    fn remove(&mut self, id: &str) -> Result<bool> {
        let statement = self
            .conn
            .prepare("DELETE FROM pairing_codes WHERE id = ?")?;
        statement.bind(&[text(id)])?;
        statement.step()?;
        Ok(statement.changes()?.0 > 0)
    }

    fn clear(&mut self) -> Result<()> {
        self.conn.exec("DELETE FROM pairing_codes")?;
        Ok(())
    }
}

fn decode_row(values: &[ace_store::Value]) -> Result<PendingCode> {
    use ace_store::Value as Sql;
    let field = |index: usize| values.get(index).cloned().unwrap_or(Sql::Null);
    let id = match field(1) {
        Sql::Text(text) => text,
        _ => {
            return Err(AuthError::Token(
                "a pairing_codes row names no id".to_owned(),
            ));
        }
    };
    let expires_at = match field(2) {
        Sql::Integer(number) => number,
        _ => {
            return Err(AuthError::Token(
                "a pairing_codes row names no expiry".to_owned(),
            ));
        }
    };
    let scopes = match field(3) {
        Sql::Text(text) => decode_scopes(&text),
        _ => Vec::new(),
    };
    Ok(PendingCode {
        id,
        expires_at,
        scopes,
        label: match field(4) {
            Sql::Text(text) => Some(text),
            _ => None,
        },
        device_ttl_ms: match field(5) {
            Sql::Integer(number) => Some(number),
            _ => None,
        },
        person: matches!(field(6), Sql::Integer(1)),
    })
}

fn decode_scopes(text: &str) -> Vec<Scope> {
    match ace_json::parse(text) {
        Ok(value) => value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().and_then(Scope::parse))
                    .collect()
            })
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn scopes_json(scopes: &[Scope]) -> String {
    let names: Vec<String> = scopes
        .iter()
        .map(|scope| format!("\"{}\"", scope.as_str()))
        .collect();
    format!("[{}]", names.join(","))
}

fn text(value: &str) -> Option<ace_store::Value> {
    Some(ace_store::Value::Text(value.to_owned()))
}

fn integer(value: i64) -> Option<ace_store::Value> {
    Some(ace_store::Value::Integer(value))
}

fn opt_integer(value: Option<i64>) -> Option<ace_store::Value> {
    value.map(ace_store::Value::Integer)
}

fn opt_text(value: Option<&str>) -> Option<ace_store::Value> {
    value.map(|text| ace_store::Value::Text(text.to_owned()))
}

#[cfg(test)]
mod tests {
    //! Ports `apps/daemon/src/pairing-codes.process.test.ts` (the database cases live beside
    //! `RemoteAuth`) and the memory store's single use and expiry order.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::{MemoryPairingCodes, PairingCodeStore, PendingCode};
    use crate::devices::Scope;

    #[test]
    fn a_memory_link_is_taken_once_and_expires_on_the_way_out() {
        let mut codes = MemoryPairingCodes::new();
        let code = PendingCode {
            id: "pairing-1".to_owned(),
            expires_at: 10_000,
            scopes: vec![Scope::Read],
            label: None,
            device_ttl_ms: None,
            person: false,
        };
        codes.put("hash", &code).unwrap();
        assert_eq!(codes.pending(9_999).unwrap().len(), 1);
        assert_eq!(codes.take("hash").unwrap(), Some(code.clone()));
        assert_eq!(codes.take("hash").unwrap(), None);
        let later = PendingCode {
            id: "pairing-2".to_owned(),
            expires_at: 20_000,
            ..code
        };
        codes.put("hash", &later).unwrap();
        assert_eq!(codes.pending(10_000).unwrap().len(), 1);
        // At its expiry the store drops it on the way out, so it can never be taken again.
        assert!(codes.pending(20_000).unwrap().is_empty());
        assert_eq!(codes.take("hash").unwrap(), None);
    }
}
