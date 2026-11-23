// SPDX-License-Identifier: Apache-2.0
//! The CLI profile store (`cli-profiles.sqlite`), read the way the TypeScript CLI reads it:
//! rows nobody can parse are skipped, never fatal for the rest. Writes use the same tables,
//! so a profile the bundle wrote reads here and back.

use std::path::Path;

use cli_out::{ErrorCode, Failure, Outcome};
use cli_wire::profile::RemoteProfile;

use super::session::CommandResult;

/// A profile name as the store reads it: `name.parse` in `profiles.ts` refuses anything
/// A profile name as the store reads it: `name.parse` in `profiles.ts` refuses anything
/// but `[a-zA-Z0-9_.-]{1,64}`, and `local` never names a row.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name != "local"
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

fn invalid_name(command: &'static str) -> Failure<'static> {
    let words = command.replace('.', " ");
    Failure::usage("An argument isn't in the form ace expects: Invalid input.")
        .with_code(ErrorCode::BadArgument)
        .with_hint(format!("See ace help {words}."))
        .with_command(command)
}

/// A profile store rooted at one ace home.
pub struct Profiles {
    conn: rusqlite::Connection,
}

fn internal(error: impl std::fmt::Display, command: &'static str) -> Failure<'static> {
    Failure::new(
        Outcome::Failed,
        format!("Something went wrong in ace: {error}."),
    )
    .with_code(ErrorCode::Internal)
    .with_hint("Run ace triage to report it.")
    .with_command(command)
}

/// Opens (creating) `<home>/cli-profiles.sqlite` with the tables the CLI keeps.
pub fn open(home: &Path, command: &'static str) -> CommandResult<Profiles> {
    if let Ok(meta) = std::fs::symlink_metadata(home)
        && meta.file_type().is_symlink()
    {
        return Err(Box::new(internal(
            format!(
                "Refusing data directory {}: it is a symbolic link",
                home.display()
            ),
            command,
        )));
    }
    std::fs::create_dir_all(home).map_err(|error| {
        Box::new(internal(
            format!("Refusing data directory {}: {error}", home.display()),
            command,
        ))
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(home).map_or(0o700, |meta| meta.permissions().mode());
        if mode & 0o077 != 0
            && let Err(error) =
                std::fs::set_permissions(home, std::fs::Permissions::from_mode(0o700))
        {
            return Err(Box::new(internal(error, command)));
        }
    }
    let conn = rusqlite::Connection::open(home.join("cli-profiles.sqlite"))
        .map_err(|error| Box::new(internal(error, command)))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS profiles(name TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS selection(id INTEGER PRIMARY KEY,name TEXT)",
    )
    .map_err(|error| Box::new(internal(error, command)))?;
    Ok(Profiles { conn })
}

impl Profiles {
    /// Every profile, ordered by name; a row this build can't read is skipped.
    pub fn list(&self, command: &'static str) -> CommandResult<Vec<RemoteProfile>> {
        let mut query = self
            .conn
            .prepare("SELECT value FROM profiles ORDER BY name")
            .map_err(|error| Box::new(internal(error, command)))?;
        let rows = query
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| Box::new(internal(error, command)))?;
        let mut profiles = Vec::new();
        for row in rows {
            let Ok(value) = row else { continue };
            if let Ok(profile) = RemoteProfile::from_json(&value) {
                profiles.push(profile);
            }
        }
        Ok(profiles)
    }

    /// The profile every command goes to, when `ace remote use` picked one.
    pub fn selected(&self, command: &'static str) -> CommandResult<Option<String>> {
        match self
            .conn
            .query_row("SELECT name FROM selection WHERE id=1", [], |row| {
                row.get::<_, Option<String>>(0)
            }) {
            Ok(name) => Ok(name),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(Box::new(internal(error, command))),
        }
    }

    /// One profile by name, or the failure the TypeScript CLI throws for an unknown one.
    pub fn get(&self, name: &str, command: &'static str) -> CommandResult<RemoteProfile> {
        if !valid_name(name) {
            return Err(Box::new(invalid_name(command)));
        }
        let value: Option<String> =
            match self
                .conn
                .query_row("SELECT value FROM profiles WHERE name=?", [name], |row| {
                    row.get(0)
                }) {
                Ok(value) => Some(value),
                Err(rusqlite::Error::QueryReturnedNoRows) => None,
                Err(error) => return Err(Box::new(internal(error, command))),
            };
        let Some(value) = value else {
            return Err(Box::new(internal(
                format!("Unknown remote profile {name}"),
                command,
            )));
        };
        RemoteProfile::from_json(&value)
            .map_err(|_| Box::new(internal(format!("Unknown remote profile {name}"), command)))
    }

    /// Send every later command to `name` (`local` for this machine).
    pub fn use_profile(&mut self, name: &str, command: &'static str) -> CommandResult<()> {
        self.conn
            .execute(
                "INSERT INTO selection VALUES (1,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name",
                rusqlite::params![if name == "local" { None } else { Some(name) }],
            )
            .map(|_| ())
            .map_err(|error| Box::new(internal(error, command)))
    }

    /// Forget one profile, and stop using it when it was the one in use.
    pub fn remove(&mut self, name: &str, command: &'static str) -> CommandResult<()> {
        self.get(name, command)?;
        let tx = self
            .conn
            .transaction()
            .map_err(|error| Box::new(internal(error, command)))?;
        tx.execute("DELETE FROM profiles WHERE name=?", [name])
            .and_then(|_| tx.execute("UPDATE selection SET name=NULL WHERE name=?", [name]))
            .map(|_| ())
            .map_err(|error| Box::new(internal(error, command)))?;
        tx.commit()
            .map_err(|error| Box::new(internal(error, command)))
    }
}
