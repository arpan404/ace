//! A move's staging database (ADR 0187, ADR 0170): its own SQLite file beside the staged parts,
//! never Spade's own connection. Every row is typed and checked to be the moving bots' own as it
//! is added; then the whole is checked there (each table holds exactly the bots' rows, with the
//! counts and hashes the manifest gave, and nothing points at a conversation that didn't come
//! with it), with no lock any other request waits on.

use std::collections::BTreeMap;
use std::path::Path;

use rusqlite::types::Value as Sql;
use rusqlite::{Connection, params};
use serde_json::json;

use super::tables::{self, Kind};
use super::{MOVE_TABLES, Row, Selection, TableSum, move_table, selection_in, sum_of};
use crate::Result;

/// The staged rows of one move.
pub struct Stage {
    connection: Connection,
    agents: Vec<String>,
    main: bool,
}

fn declared(kind: Kind) -> &'static str {
    match kind {
        Kind::Text | Kind::OptText => "TEXT",
        Kind::Int | Kind::OptInt => "INTEGER",
    }
}

impl Stage {
    /// A new, empty staging database at `path` (an old one there is replaced) for `agents`
    /// (the bot first); `main` when the bot is Spade, the main bot.
    pub fn create(path: &Path, agents: &[String], main: bool) -> Result<Self> {
        let _ = std::fs::remove_file(path);
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "journal_mode", "OFF")?;
        connection.pragma_update(None, "synchronous", "OFF")?;
        for table in MOVE_TABLES {
            let columns: Vec<String> = table
                .columns
                .iter()
                .map(|c| format!("\"{}\" {}", c.name, declared(c.kind)))
                .collect();
            connection.execute_batch(&format!(
                "CREATE TABLE {} ({});",
                table.name,
                columns.join(", ")
            ))?;
        }
        Ok(Self {
            connection,
            agents: agents.to_vec(),
            main,
        })
    }

    /// Adds one part's rows, each typed and the moving bots' own; the inner `Err` says which
    /// isn't.
    pub fn add(&mut self, name: &str, rows: Vec<Row>) -> Result<std::result::Result<(), String>> {
        let Some(table) = move_table(name) else {
            return Ok(Err(format!(
                "a part names a table Spade doesn't move: {name}"
            )));
        };
        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            table.name,
            table.select_list(),
            vec!["?"; table.columns.len()].join(", ")
        );
        let tx = self.connection.transaction()?;
        for row in rows {
            let checked = tables::typed(table, &row).and_then(|values| {
                tables::owned(table, &row, &self.agents, self.main).map(|()| values)
            });
            match checked {
                Ok(values) => {
                    tx.execute(&sql, rusqlite::params_from_iter(values.iter()))?;
                }
                Err(problem) => return Ok(Err(problem)),
            }
        }
        tx.commit()?;
        Ok(Ok(()))
    }

    /// Checks the staged whole: every table holds exactly the rows of what the bots own, with the
    /// expected count and hash, and every conversation, knowledge entry and routine those rows
    /// point at came with them. Answers what the bots own.
    pub fn verify(
        &self,
        expected: &BTreeMap<String, TableSum>,
    ) -> Result<std::result::Result<Selection, String>> {
        let selection = selection_in(&self.connection, &self.agents)?;
        for table in MOVE_TABLES {
            let all: i64 = self.connection.query_row(
                &format!("SELECT COUNT(*) FROM {}", table.name),
                [],
                |r| r.get(0),
            )?;
            let got = sum_of(&self.connection, table, &selection)?;
            let want = expected.get(table.name).cloned().unwrap_or_default();
            // A row outside what the bots own is counted in `all` but not in `got`.
            if got != want || u64::try_from(all).unwrap_or(u64::MAX) != got.rows {
                return Ok(Err(format!(
                    "{} arrived with {all} rows where {} were sent",
                    table.name, want.rows
                )));
            }
        }
        // Nothing may lead into a conversation, an entry or a routine that didn't come along:
        // here that would be another bot's.
        let conversations = json!(selection.conversations).to_string();
        let checks = [
            (
                "a conversation it names didn't come with it",
                "SELECT COUNT(*) FROM json_each(?1) WHERE value NOT IN (SELECT id FROM conversations)",
            ),
            (
                "a note links to knowledge that didn't come with it",
                "SELECT COUNT(*) FROM knowledge_links WHERE to_id NOT IN (SELECT id FROM knowledge)",
            ),
            (
                "an episode names a conversation that didn't come with it",
                "SELECT COUNT(*) FROM episodes WHERE conversation_id NOT IN (SELECT value FROM json_each(?1))",
            ),
            (
                "an ask names a conversation that didn't come with it",
                "SELECT COUNT(*) FROM inbox WHERE conversation_id NOT IN (SELECT value FROM json_each(?1))",
            ),
        ];
        for (problem, sql) in checks {
            let mut statement = self.connection.prepare(sql)?;
            let count: i64 = if statement.parameter_count() == 1 {
                statement.query_row(params![conversations], |r| r.get(0))?
            } else {
                statement.query_row([], |r| r.get(0))?
            };
            if count > 0 {
                return Ok(Err(problem.to_owned()));
            }
        }
        Ok(Ok(selection))
    }

    /// Up to `limit` staged rows of `table` after `after` (a rowid), as values in column order,
    /// with the last rowid read.
    pub(super) fn page(
        &self,
        table: &tables::MoveTable,
        after: i64,
        limit: usize,
    ) -> Result<(Vec<Vec<Sql>>, i64)> {
        let mut statement = self.connection.prepare(&format!(
            "SELECT rowid, {} FROM {} WHERE rowid > ?1 ORDER BY rowid LIMIT ?2",
            table.select_list(),
            table.name
        ))?;
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let mut rows = statement.query(params![after, limit])?;
        let (mut out, mut last) = (Vec::new(), after);
        while let Some(row) = rows.next()? {
            last = row.get(0)?;
            let values = (1..=table.columns.len())
                .map(|i| row.get::<_, Sql>(i))
                .collect::<rusqlite::Result<Vec<_>>>()?;
            out.push(values);
        }
        Ok((out, last))
    }

    /// Each moving bot's kind as it came.
    pub(super) fn kinds(&self) -> Result<Vec<(String, String)>> {
        let mut statement = self.connection.prepare("SELECT id, kind FROM agents")?;
        let rows = statement.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}
