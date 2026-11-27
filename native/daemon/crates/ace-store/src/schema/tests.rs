// SPDX-License-Identifier: Apache-2.0
//! `migrations.process.test.ts`'s cases, against the generated steps.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::{MIGRATIONS, UPGRADE_FLOOR, migrate, version};
use crate::{Connection, OpenOptions, Value};

/// A database in its own directory, removed when the test ends.
struct Home {
    directory: PathBuf,
}

impl Home {
    fn new(name: &str) -> Self {
        let directory = std::env::temp_dir().join(format!(
            "ace-schema-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).expect("temp home");
        Self { directory }
    }

    fn database(&self) -> PathBuf {
        self.directory.join("events.sqlite")
    }

    fn open(&self) -> Arc<Connection> {
        Connection::open(
            &self.database().to_string_lossy(),
            OpenOptions {
                read_only: false,
                timeout_ms: 0,
            },
        )
        .expect("open database")
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn scalar(connection: &Arc<Connection>, sql: &str) -> Option<Value> {
    connection
        .prepare(sql)
        .expect("prepare")
        .step()
        .expect("step")
        .and_then(|values| values.into_iter().next())
}

fn tables(connection: &Arc<Connection>) -> Vec<String> {
    let statement = connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .expect("prepare");
    let mut names = Vec::new();
    while let Some(values) = statement.step().expect("step") {
        if let Some(Value::Text(name)) = values.into_iter().next() {
            names.push(name);
        }
    }
    names
}

fn stored_version(connection: &Arc<Connection>) -> i64 {
    match scalar(
        connection,
        "SELECT version FROM schema_version WHERE id = 1",
    ) {
        Some(Value::Integer(version)) => version,
        other => panic!("schema_version holds an integer, found {other:?}"),
    }
}

fn readable(path: &Path) -> Arc<Connection> {
    Connection::open(
        &path.to_string_lossy(),
        OpenOptions {
            read_only: true,
            timeout_ms: 0,
        },
    )
    .expect("read-only open")
}

#[test]
fn a_fresh_database_runs_every_step_and_records_this_build_s_version() {
    let home = Home::new("fresh");
    let connection = home.open();
    migrate(&connection).expect("migrate a fresh database");
    assert_eq!(stored_version(&connection), version());
    assert_eq!(version() as usize, MIGRATIONS.len());
    let names = tables(&connection);
    // `pairing_codes` is `ace-auth`'s table, created when the daemon opens authentication.
    for expected in ["events", "threads", "items", "devices", "host_sequence"] {
        assert!(
            names.iter().any(|name| name == expected),
            "{expected} exists, tables are {names:?}"
        );
    }
    // Each step records itself, so the last one is the version the schema table holds.
    assert_eq!(stored_version(&connection), MIGRATIONS.len() as i64);
}

#[test]
fn a_database_this_build_wrote_is_opened_again_without_running_a_step() {
    let home = Home::new("reopen");
    let connection = home.open();
    migrate(&connection).expect("first migrate");
    connection
        .exec(
            "INSERT INTO workspaces (id, path, name, created_at) VALUES ('w', '/repo', 'repo', 1)",
        )
        .expect("a workspace");
    // Every step is one-shot (`CREATE TABLE events` without IF NOT EXISTS), so a second pass
    // that runs any of them fails; this passes only if it runs none.
    migrate(&connection).expect("second migrate on the same version");
    assert_eq!(stored_version(&connection), version());
    assert_eq!(
        scalar(&connection, "SELECT id FROM workspaces"),
        Some(Value::Text("w".to_owned()))
    );
}

#[test]
fn a_database_at_an_older_schema_is_refused_untouched() {
    // `migrations.process.test.ts`: "a daemon database at older schema %s is refused untouched
    // instead of upgraded", for 1, 9 and 13 (every version below the floor).
    for older in [1_i64, 9, 13] {
        assert!(older < UPGRADE_FLOOR, "{older} is below the floor");
        let home = Home::new(&format!("older-{older}"));
        let connection = home.open();
        connection
            .exec(
                "CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL); \
                 INSERT INTO schema_version VALUES (1, 13); \
                 CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL); \
                 INSERT INTO workspaces VALUES ('kept', '/repo', 'repo', 1);",
            )
            .expect("a database from an older build");
        let update = connection
            .prepare("UPDATE schema_version SET version = ? WHERE id = 1")
            .expect("prepare");
        update.bind(&[Some(Value::Integer(older))]).expect("bind");
        update.step().expect("set the version");
        let error = migrate(&connection).expect_err("an older schema is refused");
        let message = error.to_string();
        assert!(
            message.contains(&format!(
                "schema {older}, and this build reads schema {}",
                version()
            )),
            "{message}"
        );
        assert!(
            message.contains("Quit ace, then start it with a fresh ACE_HOME."),
            "{message}"
        );
        assert!(error.refusal().is_some(), "a refusal, not a SQLite failure");

        let after = readable(&home.database());
        assert_eq!(stored_version(&after), older, "the version is untouched");
        assert_eq!(
            scalar(&after, "SELECT id FROM workspaces"),
            Some(Value::Text("kept".to_owned())),
            "the rows are untouched"
        );
        assert!(
            !tables(&after).iter().any(|name| name == "events"),
            "no step ran"
        );
    }
}

#[test]
fn a_database_newer_than_this_build_is_refused() {
    let home = Home::new("newer");
    let connection = home.open();
    migrate(&connection).expect("migrate a fresh database");
    let newer = version() + 1;
    let update = connection
        .prepare("UPDATE schema_version SET version = ? WHERE id = 1")
        .expect("prepare");
    update.bind(&[Some(Value::Integer(newer))]).expect("bind");
    update.step().expect("set the version");
    let error = migrate(&connection).expect_err("a newer schema is refused");
    let message = error.to_string();
    assert!(
        message.contains(&format!(
            "schema {newer}, newer than this build's {}",
            version()
        )),
        "{message}"
    );
    assert!(
        message.contains("Open the newest ace, or update this one."),
        "{message}"
    );
    assert_eq!(
        stored_version(&connection),
        newer,
        "the version is untouched"
    );
}

#[test]
fn a_database_missing_a_thread_column_is_refused_rather_than_repaired() {
    let home = Home::new("columns");
    let connection = home.open();
    migrate(&connection).expect("migrate a fresh database");
    connection
        .exec("ALTER TABLE threads DROP COLUMN acp")
        .expect("drop a thread metadata column");
    let error = migrate(&connection).expect_err("a missing thread column is refused");
    let message = error.to_string();
    assert!(
        message.contains("lacks thread columns acp from its schema"),
        "{message}"
    );
    assert_eq!(stored_version(&connection), version());
}
