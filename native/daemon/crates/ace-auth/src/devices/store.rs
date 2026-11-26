// SPDX-License-Identifier: Apache-2.0
//! The store's own statements (`devices.ts:132`-`:179`): the row lookups the other modules ask
//! for, and the small SQL shell each one runs on `ace-store`'s connection.

use ace_store::{Statement, Value};

use crate::devices::{COLUMNS, decode, integer, text};
use crate::error::Result;

use super::{Devices, Row};

impl Devices {
    pub(crate) fn by_id(&self, id: &str) -> Result<Option<Row>> {
        Ok(self
            .all(
                &format!("SELECT {COLUMNS} FROM devices WHERE id = ?"),
                &[text(id)],
            )?
            .into_iter()
            .next())
    }

    pub(crate) fn by_install(&self, install_id: &str, at: i64) -> Result<Option<Row>> {
        Ok(self
            .all(
                &format!(
                    "SELECT {COLUMNS} FROM devices WHERE install_id = ? AND merged_into IS NULL \
                         AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) \
                         ORDER BY last_seen_at DESC, id LIMIT 1"
                ),
                &[text(install_id), integer(at)],
            )?
            .into_iter()
            .next())
    }

    pub(crate) fn orphans(
        &self,
        id: &str,
        name: &str,
        created_at: i64,
        at: i64,
    ) -> Result<Vec<Row>> {
        self.all(
            &format!(
                "SELECT {COLUMNS} FROM devices WHERE id != ? AND install_id IS NULL \
                     AND merged_into IS NULL AND name = ? AND last_seen_at < ? \
                     AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) \
                     AND scopes NOT LIKE '%\"desktop\"%' AND scopes NOT LIKE '%\"user-browser\"%'"
            ),
            &[text(id), text(name), integer(created_at), integer(at)],
        )
    }

    pub(crate) fn prepare(&self, sql: &str) -> Result<Statement> {
        Ok(self.conn.prepare(sql)?)
    }

    pub(crate) fn all(&self, sql: &str, params: &[Option<Value>]) -> Result<Vec<Row>> {
        let statement = self.prepare(sql)?;
        statement.bind(params)?;
        let mut rows = Vec::new();
        while let Some(values) = statement.step()? {
            rows.push(decode(&values)?);
        }
        Ok(rows)
    }

    /// A query of one TEXT column.
    pub(crate) fn ids(&self, sql: &str, params: &[Option<Value>]) -> Result<Vec<String>> {
        let statement = self.prepare(sql)?;
        statement.bind(params)?;
        let mut ids = Vec::new();
        while let Some(values) = statement.step()? {
            if let Some(Value::Text(text)) = values.first() {
                ids.push(text.clone());
            }
        }
        Ok(ids)
    }

    pub(crate) fn execute(&self, sql: &str, params: &[Option<Value>]) -> Result<()> {
        let statement = self.prepare(sql)?;
        statement.bind(params)?;
        statement.step()?;
        Ok(())
    }

    pub(crate) fn changed(&self, sql: &str, params: &[Option<Value>]) -> Result<i64> {
        let statement = self.prepare(sql)?;
        statement.bind(params)?;
        statement.step()?;
        Ok(statement.changes()?.0)
    }
}
