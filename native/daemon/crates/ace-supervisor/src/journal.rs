// SPDX-License-Identifier: Apache-2.0
//! Beside the process inventory, by pid and kernel start: escapees (a run's
//! processes that left its groups), kept (processes launched to outlive ace)
//! and lineage (macOS unique ids). Ports `escapee-journal.ts`. One SQLite
//! file holds all four tables; rows hold kernel identities and a run id.

use crate::errors::SupervisorError;
use ace_store::{Connection, OpenOptions, Value};
use std::sync::Arc;

const ROW_LIMIT: i64 = 4_096;

/// An escapee: a leftover of an earlier run, if still running.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EscapeeRow {
    pub pid: u32,
    pub start: String,
    pub run: String,
}

/// A member pinned by pid and kernel start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalMember {
    pub pid: u32,
    pub start: String,
}

/// What one run recorded: its escapees, every kept process, its lineage.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Ownership {
    pub escapees: Vec<JournalMember>,
    pub kept: Vec<JournalMember>,
    pub lineage: Vec<String>,
}

fn bind_text(value: &str) -> Option<Value> {
    Some(Value::Text(value.to_owned()))
}

fn bind_int(value: i64) -> Option<Value> {
    Some(Value::Integer(value))
}

fn cell_int(cell: &Value) -> Result<i64, SupervisorError> {
    match cell {
        Value::Integer(value) => Ok(*value),
        _ => Err(SupervisorError::Journal("bad journal row".to_owned())),
    }
}

fn cell_text(cell: &Value) -> Result<String, SupervisorError> {
    match cell {
        Value::Text(value) => Ok(value.clone()),
        _ => Err(SupervisorError::Journal("bad journal row".to_owned())),
    }
}

/// The escapee journal over `path`, opened through the store's connection so
/// one SQLite library touches the file.
pub struct EscapeeJournal {
    db: Arc<Connection>,
    run: String,
}

impl EscapeeJournal {
    /// Opens (creating) the journal and its tables.
    pub fn open(path: &str, run: &str) -> Result<Self, SupervisorError> {
        let db = Connection::open(path, OpenOptions::default())
            .map_err(|error| SupervisorError::journal("escapee journal open", error))?;
        db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
            .map_err(|error| SupervisorError::journal("escapee journal pragmas", error))?;
        for schema in [
            "CREATE TABLE IF NOT EXISTS escapees(pid INTEGER NOT NULL,start TEXT NOT NULL,run TEXT NOT NULL,PRIMARY KEY(pid,start))",
            "CREATE TABLE IF NOT EXISTS kept(pid INTEGER NOT NULL,start TEXT NOT NULL,PRIMARY KEY(pid,start))",
            "CREATE TABLE IF NOT EXISTS lineage(unique_id TEXT NOT NULL PRIMARY KEY,run TEXT NOT NULL)",
        ] {
            db.exec(schema)
                .map_err(|error| SupervisorError::journal("escapee journal schema", error))?;
        }
        Ok(Self {
            db,
            run: run.to_owned(),
        })
    }

    fn count(&self, table: &str) -> Result<i64, SupervisorError> {
        let statement = self
            .db
            .prepare(&format!("SELECT COUNT(*) AS n FROM {table}"))
            .map_err(|error| SupervisorError::journal("escapee journal count", error))?;
        statement
            .bind(&[])
            .map_err(|error| SupervisorError::journal("escapee journal count", error))?;
        let row = statement
            .step()
            .map_err(|error| SupervisorError::journal("escapee journal count", error))?;
        let Some(row) = row else {
            return Err(SupervisorError::Journal("escapee journal count".to_owned()));
        };
        cell_int(&row[0])
    }

    /// Records members that left their group or tree.
    pub fn record(&self, members: &[JournalMember]) -> Result<(), SupervisorError> {
        let count = self.count("escapees")?;
        let statement = self
            .db
            .prepare("INSERT INTO escapees VALUES (?,?,?) ON CONFLICT(pid,start) DO UPDATE SET run=excluded.run")
            .map_err(|error| SupervisorError::journal("escapee journal record", error))?;
        for member in members.iter().take((ROW_LIMIT - count).max(0) as usize) {
            statement
                .bind(&[
                    bind_int(member.pid as i64),
                    bind_text(&member.start),
                    bind_text(&self.run),
                ])
                .map_err(|error| SupervisorError::journal("escapee journal record", error))?;
            while statement
                .step()
                .map_err(|error| SupervisorError::journal("escapee journal record", error))?
                .is_some()
            {}
        }
        Ok(())
    }

    /// Forgets members that are gone.
    pub fn forget(&self, members: &[JournalMember]) -> Result<(), SupervisorError> {
        let statement = self
            .db
            .prepare("DELETE FROM escapees WHERE pid=? AND start=?")
            .map_err(|error| SupervisorError::journal("escapee journal forget", error))?;
        for member in members {
            statement
                .bind(&[bind_int(member.pid as i64), bind_text(&member.start)])
                .map_err(|error| SupervisorError::journal("escapee journal forget", error))?;
            while statement
                .step()
                .map_err(|error| SupervisorError::journal("escapee journal forget", error))?
                .is_some()
            {}
        }
        Ok(())
    }

    /// What earlier runs recorded and never forgot: their leftovers.
    pub fn earlier(&self) -> Result<Vec<EscapeeRow>, SupervisorError> {
        let statement = self
            .db
            .prepare("SELECT pid,start,run FROM escapees WHERE run<>? ORDER BY pid")
            .map_err(|error| SupervisorError::journal("escapee journal earlier", error))?;
        statement
            .bind(&[bind_text(&self.run)])
            .map_err(|error| SupervisorError::journal("escapee journal earlier", error))?;
        let mut rows = Vec::new();
        while let Some(row) = statement
            .step()
            .map_err(|error| SupervisorError::journal("escapee journal earlier", error))?
        {
            rows.push(EscapeeRow {
                pid: cell_int(&row[0])? as u32,
                start: cell_text(&row[1])?,
                run: cell_text(&row[2])?,
            });
        }
        Ok(rows)
    }

    /// Records that `member` was launched to outlive ace. Spent rows
    /// (processes long gone) are dropped first, so the table never fills.
    pub fn keep(
        &self,
        member: &JournalMember,
        alive: &dyn Fn(u32) -> bool,
    ) -> Result<(), SupervisorError> {
        if self.count("kept")? >= ROW_LIMIT {
            for row in self.kept()? {
                if !alive(row.pid) {
                    self.unkeep(&row)?;
                }
            }
        }
        let statement = self
            .db
            .prepare("INSERT INTO kept VALUES (?,?) ON CONFLICT(pid,start) DO NOTHING")
            .map_err(|error| SupervisorError::journal("escapee journal keep", error))?;
        statement
            .bind(&[bind_int(member.pid as i64), bind_text(&member.start)])
            .map_err(|error| SupervisorError::journal("escapee journal keep", error))?;
        while statement
            .step()
            .map_err(|error| SupervisorError::journal("escapee journal keep", error))?
            .is_some()
        {}
        Ok(())
    }

    /// Drops one kept record.
    pub fn unkeep(&self, member: &JournalMember) -> Result<(), SupervisorError> {
        let statement = self
            .db
            .prepare("DELETE FROM kept WHERE pid=? AND start=?")
            .map_err(|error| SupervisorError::journal("escapee journal unkeep", error))?;
        statement
            .bind(&[bind_int(member.pid as i64), bind_text(&member.start)])
            .map_err(|error| SupervisorError::journal("escapee journal unkeep", error))?;
        while statement
            .step()
            .map_err(|error| SupervisorError::journal("escapee journal unkeep", error))?
            .is_some()
        {}
        Ok(())
    }

    /// Records unique ids of this run's processes.
    pub fn record_lineage(&self, uniques: &[String]) -> Result<(), SupervisorError> {
        let statement = self
            .db
            .prepare("INSERT INTO lineage VALUES (?,?) ON CONFLICT(unique_id) DO UPDATE SET run=excluded.run")
            .map_err(|error| SupervisorError::journal("escapee journal lineage", error))?;
        for unique in uniques {
            statement
                .bind(&[bind_text(unique), bind_text(&self.run)])
                .map_err(|error| SupervisorError::journal("escapee journal lineage", error))?;
            while statement
                .step()
                .map_err(|error| SupervisorError::journal("escapee journal lineage", error))?
                .is_some()
            {}
        }
        Ok(())
    }

    /// Drops lineage rows of runs other than this one: spent once it started.
    pub fn forget_earlier_lineage(&self) -> Result<(), SupervisorError> {
        self.db
            .prepare("DELETE FROM lineage WHERE run<>?")
            .map_err(|error| SupervisorError::journal("escapee journal lineage", error))
            .and_then(|statement| {
                statement
                    .bind(&[bind_text(&self.run)])
                    .map_err(|error| SupervisorError::journal("escapee journal lineage", error))?;
                while statement
                    .step()
                    .map_err(|error| SupervisorError::journal("escapee journal lineage", error))?
                    .is_some()
                {}
                Ok(())
            })
    }

    /// Every process kept to outlive ace.
    pub fn kept(&self) -> Result<Vec<JournalMember>, SupervisorError> {
        let statement = self
            .db
            .prepare("SELECT pid,start FROM kept ORDER BY pid")
            .map_err(|error| SupervisorError::journal("escapee journal kept", error))?;
        statement
            .bind(&[])
            .map_err(|error| SupervisorError::journal("escapee journal kept", error))?;
        let mut rows = Vec::new();
        while let Some(row) = statement
            .step()
            .map_err(|error| SupervisorError::journal("escapee journal kept", error))?
        {
            rows.push(JournalMember {
                pid: cell_int(&row[0])? as u32,
                start: cell_text(&row[1])?,
            });
        }
        Ok(rows)
    }

    /// Closes the journal.
    pub fn close(&self) -> Result<(), SupervisorError> {
        self.db
            .close()
            .map_err(|error| SupervisorError::journal("escapee journal close", error))
    }
}

/// Read-only, for `ace stop`: a run's escapees and lineage, and every
/// process kept to outlive ace.
pub fn read_ownership(path: &str, run: Option<&str>) -> Result<Ownership, SupervisorError> {
    if !std::path::Path::new(path).exists() {
        return Ok(Ownership::default());
    }
    let db = Connection::open(
        path,
        OpenOptions {
            read_only: true,
            ..OpenOptions::default()
        },
    )
    .map_err(|error| SupervisorError::journal("escapee journal open", error))?;
    let has = |table: &str| -> Result<bool, SupervisorError> {
        let statement = db
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
            .map_err(|error| SupervisorError::journal("escapee journal tables", error))?;
        statement
            .bind(&[bind_text(table)])
            .map_err(|error| SupervisorError::journal("escapee journal tables", error))?;
        Ok(statement
            .step()
            .map_err(|error| SupervisorError::journal("escapee journal tables", error))?
            .is_some())
    };
    let select =
        |sql: &str, run: Option<&str>| -> Result<Vec<Vec<ace_store::Value>>, SupervisorError> {
            let statement = db
                .prepare(sql)
                .map_err(|error| SupervisorError::journal("escapee journal read", error))?;
            if let Some(run) = run {
                statement
                    .bind(&[bind_text(run)])
                    .map_err(|error| SupervisorError::journal("escapee journal read", error))?;
            } else {
                statement
                    .bind(&[])
                    .map_err(|error| SupervisorError::journal("escapee journal read", error))?;
            }
            let mut rows = Vec::new();
            while let Some(row) = statement
                .step()
                .map_err(|error| SupervisorError::journal("escapee journal read", error))?
            {
                rows.push(row);
            }
            Ok(rows)
        };
    let escapees = if run.is_some() && has("escapees")? {
        select(
            "SELECT pid,start FROM escapees WHERE run=? ORDER BY pid",
            run,
        )?
        .into_iter()
        .map(|row| {
            Ok(JournalMember {
                pid: cell_int(&row[0])? as u32,
                start: cell_text(&row[1])?,
            })
        })
        .collect::<Result<Vec<_>, SupervisorError>>()?
    } else {
        Vec::new()
    };
    let kept = if has("kept")? {
        select("SELECT pid,start FROM kept ORDER BY pid", None)?
            .into_iter()
            .map(|row| {
                Ok(JournalMember {
                    pid: cell_int(&row[0])? as u32,
                    start: cell_text(&row[1])?,
                })
            })
            .collect::<Result<Vec<_>, SupervisorError>>()?
    } else {
        Vec::new()
    };
    let lineage = if run.is_some() && has("lineage")? {
        select("SELECT unique_id FROM lineage WHERE run=?", run)?
            .into_iter()
            .map(|row| cell_text(&row[0]))
            .collect::<Result<Vec<_>, SupervisorError>>()?
    } else {
        Vec::new()
    };
    db.close()
        .map_err(|error| SupervisorError::journal("escapee journal close", error))?;
    Ok(Ownership {
        escapees,
        kept,
        lineage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_scratch::Scratch;

    fn member(pid: u32, start: &str) -> JournalMember {
        JournalMember {
            pid,
            start: start.to_owned(),
        }
    }

    #[test]
    fn escapees_record_forget_and_read_back_by_run() {
        let scratch = Scratch::new();
        let path = scratch.file("processes.sqlite");
        let journal = EscapeeJournal::open(&path, "run-a").expect("journal opens");
        journal
            .record(&[member(10, "s10"), member(20, "s20")])
            .expect("records");
        journal.forget(&[member(10, "s10")]).expect("forgets");
        // Same run sees nothing earlier; a later run sees the leftover.
        assert!(journal.earlier().expect("earlier").is_empty());
        let next = EscapeeJournal::open(&path, "run-b").expect("journal opens");
        assert_eq!(
            next.earlier().expect("earlier"),
            vec![crate::journal::EscapeeRow {
                pid: 20,
                start: "s20".to_owned(),
                run: "run-a".to_owned(),
            }]
        );
        journal.close().expect("closes");
        next.close().expect("closes");
    }

    #[test]
    fn kept_and_lineage_read_back_for_stop() {
        let scratch = Scratch::new();
        let path = scratch.file("processes.sqlite");
        let journal = EscapeeJournal::open(&path, "run-a").expect("journal opens");
        journal.keep(&member(30, "s30"), &|_| true).expect("keeps");
        journal
            .record_lineage(&["u1".to_owned()])
            .expect("records lineage");
        journal.forget_earlier_lineage().expect("forgets earlier");
        let ownership = read_ownership(&path, Some("run-a")).expect("reads");
        assert_eq!(ownership.kept, vec![member(30, "s30")]);
        assert_eq!(ownership.lineage, vec!["u1".to_owned()]);
        assert!(ownership.escapees.is_empty());
        assert!(
            read_ownership(&scratch.file("missing.sqlite"), Some("run-a"))
                .expect("reads")
                .kept
                .is_empty()
        );
    }
}
