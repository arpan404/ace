// SPDX-License-Identifier: Apache-2.0
//! A connection to the bundled SQLite, safe to share between threads and to outlive any one
//! call: statements are owned by their connection and addressed by id, so a statement a
//! JavaScript iterator steps across calls never borrows anything. This module is the only
//! unsafe code in the crate; every block says why it holds.

use libsqlite3_sys as ffi;
use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char, c_int};
use std::ptr::{self, NonNull};
use std::sync::{Arc, Mutex, MutexGuard};

/// A value SQLite stores, as node:sqlite reads and binds it.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

/// Why an operation failed. `Sqlite` carries SQLite's extended result code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrorKind {
    Sqlite,
    /// The SQL text held no statement.
    NoStatement,
    /// The connection was closed.
    Closed,
    /// The statement was finalized (its connection closed).
    Finalized,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub kind: ErrorKind,
    /// SQLite's extended result code, or 0 for the other kinds.
    pub code: i32,
    /// SQLite's message for this failure (`sqlite3_errmsg`), or ours.
    pub message: String,
    /// SQLite's description of the code (`sqlite3_errstr`).
    pub errstr: String,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

fn own(kind: ErrorKind, message: &str) -> Error {
    Error {
        kind,
        code: 0,
        message: message.to_owned(),
        errstr: String::new(),
    }
}

fn errstr(code: c_int) -> String {
    // SAFETY: sqlite3_errstr returns a static, NUL-terminated string for any code.
    unsafe { CStr::from_ptr(ffi::sqlite3_errstr(code)) }
        .to_string_lossy()
        .into_owned()
}

/// How a connection opens.
#[derive(Debug, Clone, Copy, Default)]
pub struct OpenOptions {
    pub read_only: bool,
    /// `sqlite3_busy_timeout`, in milliseconds; 0 waits for nothing, as node:sqlite's default.
    pub timeout_ms: i32,
}

struct Raw {
    db: NonNull<ffi::sqlite3>,
    statements: HashMap<u64, NonNull<ffi::sqlite3_stmt>>,
    next: u64,
}

// SAFETY: SQLite is built with SQLITE_THREADSAFE=1 and every connection opens with
// SQLITE_OPEN_FULLMUTEX; in addition every use of these pointers holds the connection's mutex,
// so no two threads touch the handle or its statements at once.
unsafe impl Send for Raw {}

/// One SQLite connection. Share it with `Arc`; statements keep it alive.
pub struct Connection {
    raw: Mutex<Option<Raw>>,
}

impl Connection {
    pub fn open(path: &str, options: OpenOptions) -> Result<Arc<Connection>> {
        let c_path = CString::new(path).map_err(|_| own(ErrorKind::Sqlite, "path holds NUL"))?;
        let mut db: *mut ffi::sqlite3 = ptr::null_mut();
        let flags = ffi::SQLITE_OPEN_FULLMUTEX
            | if options.read_only {
                ffi::SQLITE_OPEN_READONLY
            } else {
                ffi::SQLITE_OPEN_READWRITE | ffi::SQLITE_OPEN_CREATE
            };
        // SAFETY: c_path is NUL-terminated and outlives the call; db is an out pointer.
        let rc = unsafe { ffi::sqlite3_open_v2(c_path.as_ptr(), &mut db, flags, ptr::null()) };
        let Some(handle) = NonNull::new(db) else {
            return Err(Error {
                kind: ErrorKind::Sqlite,
                code: rc,
                message: errstr(rc),
                errstr: errstr(rc),
            });
        };
        if rc != ffi::SQLITE_OK {
            let error = last_error(handle, rc);
            // SAFETY: the handle came from sqlite3_open_v2 and has no statements.
            unsafe { ffi::sqlite3_close(handle.as_ptr()) };
            return Err(error);
        }
        // SAFETY: a valid handle; these calls only set connection flags. node:sqlite's
        // defaults: extended result codes, foreign keys on, no double-quoted string literals.
        unsafe {
            ffi::sqlite3_extended_result_codes(handle.as_ptr(), 1);
            ffi::sqlite3_db_config(
                handle.as_ptr(),
                ffi::SQLITE_DBCONFIG_ENABLE_FKEY,
                1 as c_int,
                ptr::null_mut::<c_int>(),
            );
            ffi::sqlite3_db_config(
                handle.as_ptr(),
                ffi::SQLITE_DBCONFIG_DQS_DML,
                0 as c_int,
                ptr::null_mut::<c_int>(),
            );
            ffi::sqlite3_db_config(
                handle.as_ptr(),
                ffi::SQLITE_DBCONFIG_DQS_DDL,
                0 as c_int,
                ptr::null_mut::<c_int>(),
            );
            ffi::sqlite3_busy_timeout(handle.as_ptr(), options.timeout_ms);
        }
        Ok(Arc::new(Connection {
            raw: Mutex::new(Some(Raw {
                db: handle,
                statements: HashMap::new(),
                next: 0,
            })),
        }))
    }

    fn lock(&self) -> MutexGuard<'_, Option<Raw>> {
        // A panic while holding the lock leaves SQLite's state as SQLite left it; keep going.
        self.raw
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn with<T>(&self, run: impl FnOnce(&mut Raw) -> Result<T>) -> Result<T> {
        match self.lock().as_mut() {
            Some(raw) => run(raw),
            None => Err(own(ErrorKind::Closed, "database is not open")),
        }
    }

    pub fn is_open(&self) -> bool {
        self.lock().is_some()
    }

    /// Run every statement in `sql`.
    pub fn exec(&self, sql: &str) -> Result<()> {
        let c_sql = CString::new(sql).map_err(|_| own(ErrorKind::Sqlite, "SQL holds NUL"))?;
        self.with(|raw| {
            let mut message: *mut c_char = ptr::null_mut();
            // SAFETY: a valid handle under the lock; c_sql outlives the call; no callback.
            let rc = unsafe {
                ffi::sqlite3_exec(
                    raw.db.as_ptr(),
                    c_sql.as_ptr(),
                    None,
                    ptr::null_mut(),
                    &mut message,
                )
            };
            if !message.is_null() {
                // SAFETY: sqlite3_exec allocated it with sqlite3_malloc.
                unsafe { ffi::sqlite3_free(message.cast()) };
            }
            if rc == ffi::SQLITE_OK {
                Ok(())
            } else {
                Err(last_error(raw.db, rc))
            }
        })
    }

    /// Prepare the first statement in `sql`, as `sqlite3_prepare_v2` does.
    pub fn prepare(self: &Arc<Self>, sql: &str) -> Result<Statement> {
        let id = self.with(|raw| {
            let mut stmt: *mut ffi::sqlite3_stmt = ptr::null_mut();
            let length = c_int::try_from(sql.len())
                .map_err(|_| own(ErrorKind::Sqlite, "SQL is too long"))?;
            // SAFETY: a valid handle under the lock; sql's bytes outlive the call and their
            // length is passed, so no NUL is needed; stmt is an out pointer.
            let rc = unsafe {
                ffi::sqlite3_prepare_v2(
                    raw.db.as_ptr(),
                    sql.as_ptr().cast(),
                    length,
                    &mut stmt,
                    ptr::null_mut(),
                )
            };
            if rc != ffi::SQLITE_OK {
                return Err(last_error(raw.db, rc));
            }
            let Some(stmt) = NonNull::new(stmt) else {
                return Err(own(
                    ErrorKind::NoStatement,
                    "The SQL query contains no statements.",
                ));
            };
            raw.next += 1;
            raw.statements.insert(raw.next, stmt);
            Ok(raw.next)
        })?;
        Ok(Statement {
            connection: Arc::clone(self),
            id,
        })
    }

    /// Whether a transaction is open (SQLite is out of autocommit mode).
    pub fn is_transaction(&self) -> Result<bool> {
        // SAFETY: a valid handle under the lock.
        self.with(|raw| Ok(unsafe { ffi::sqlite3_get_autocommit(raw.db.as_ptr()) } == 0))
    }

    /// The main database's file, or None for an in-memory or temporary one.
    pub fn location(&self) -> Result<Option<String>> {
        self.with(|raw| {
            // SAFETY: a valid handle under the lock; "main" is NUL-terminated. The returned
            // string lives as long as the connection, and is copied before the lock drops.
            let name = unsafe { ffi::sqlite3_db_filename(raw.db.as_ptr(), c"main".as_ptr()) };
            if name.is_null() {
                return Ok(None);
            }
            // SAFETY: non-null, NUL-terminated, valid while the connection is open.
            let path = unsafe { CStr::from_ptr(name) }
                .to_string_lossy()
                .into_owned();
            Ok(if path.is_empty() { None } else { Some(path) })
        })
    }

    /// Copy the main database to a new file at `path` with SQLite's online backup, as
    /// node:sqlite's `backup` does; returns the pages copied.
    pub fn backup(&self, path: &str) -> Result<i64> {
        let destination = Connection::open(path, OpenOptions::default())?;
        let target = destination.lock();
        let Some(target) = target.as_ref() else {
            return Err(own(ErrorKind::Closed, "database is not open"));
        };
        self.with(|raw| {
            // SAFETY: both handles are valid and locked; "main" is NUL-terminated. The backup
            // object is finished before either lock drops.
            unsafe {
                let backup = ffi::sqlite3_backup_init(
                    target.db.as_ptr(),
                    c"main".as_ptr(),
                    raw.db.as_ptr(),
                    c"main".as_ptr(),
                );
                if backup.is_null() {
                    return Err(last_error(target.db, ffi::SQLITE_ERROR));
                }
                let step = ffi::sqlite3_backup_step(backup, -1);
                let pages = ffi::sqlite3_backup_pagecount(backup);
                let finish = ffi::sqlite3_backup_finish(backup);
                if step != ffi::SQLITE_DONE {
                    return Err(last_error(target.db, step));
                }
                if finish != ffi::SQLITE_OK {
                    return Err(last_error(target.db, finish));
                }
                Ok(i64::from(pages))
            }
        })
    }

    /// Finalize every statement and close. Later use fails; closing twice does nothing.
    pub fn close(&self) -> Result<()> {
        let Some(raw) = self.lock().take() else {
            return Ok(());
        };
        for (_, stmt) in raw.statements {
            // SAFETY: each statement belongs to this connection and is finalized once.
            unsafe { ffi::sqlite3_finalize(stmt.as_ptr()) };
        }
        // SAFETY: every statement is finalized, so the handle closes now.
        let rc = unsafe { ffi::sqlite3_close(raw.db.as_ptr()) };
        if rc == ffi::SQLITE_OK {
            Ok(())
        } else {
            Err(Error {
                kind: ErrorKind::Sqlite,
                code: rc,
                message: errstr(rc),
                errstr: errstr(rc),
            })
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

fn last_error(db: NonNull<ffi::sqlite3>, rc: c_int) -> Error {
    // SAFETY: a valid handle; the message is copied before any other call on it.
    let (code, message) = unsafe {
        let code = ffi::sqlite3_extended_errcode(db.as_ptr());
        let message = CStr::from_ptr(ffi::sqlite3_errmsg(db.as_ptr()))
            .to_string_lossy()
            .into_owned();
        (code, message)
    };
    // A failed call's own code wins when the connection's is stale (bind errors set it too).
    let code = if code == ffi::SQLITE_OK { rc } else { code };
    Error {
        kind: ErrorKind::Sqlite,
        code,
        message,
        errstr: errstr(code),
    }
}

/// A prepared statement, owned by its connection; dropping it finalizes it.
pub struct Statement {
    connection: Arc<Connection>,
    id: u64,
}

impl Statement {
    fn with<T>(
        &self,
        run: impl FnOnce(NonNull<ffi::sqlite3>, NonNull<ffi::sqlite3_stmt>) -> Result<T>,
    ) -> Result<T> {
        self.connection
            .with(|raw| match raw.statements.get(&self.id) {
                Some(stmt) => run(raw.db, *stmt),
                None => Err(own(ErrorKind::Finalized, "statement has been finalized")),
            })
    }

    /// Parameter names by index from 1, None for an anonymous `?`.
    pub fn parameter_names(&self) -> Result<Vec<Option<String>>> {
        self.with(|_, stmt| {
            // SAFETY: a live statement under the connection's lock.
            let count = unsafe { ffi::sqlite3_bind_parameter_count(stmt.as_ptr()) };
            Ok((1..=count)
                .map(|index| {
                    // SAFETY: as above; the name is copied at once.
                    let name = unsafe { ffi::sqlite3_bind_parameter_name(stmt.as_ptr(), index) };
                    (!name.is_null()).then(|| {
                        unsafe { CStr::from_ptr(name) }
                            .to_string_lossy()
                            .into_owned()
                    })
                })
                .collect())
        })
    }

    /// Result column names, in order.
    pub fn columns(&self) -> Result<Vec<String>> {
        self.with(|_, stmt| {
            // SAFETY: a live statement under the connection's lock; names are copied at once.
            let count = unsafe { ffi::sqlite3_column_count(stmt.as_ptr()) };
            Ok((0..count)
                .map(|index| {
                    let name = unsafe { ffi::sqlite3_column_name(stmt.as_ptr(), index) };
                    if name.is_null() {
                        String::new()
                    } else {
                        unsafe { CStr::from_ptr(name) }
                            .to_string_lossy()
                            .into_owned()
                    }
                })
                .collect())
        })
    }

    /// Reset, clear bindings, then bind `params[i]` to parameter `i + 1` (None stays NULL).
    pub fn bind(&self, params: &[Option<Value>]) -> Result<()> {
        self.with(|db, stmt| {
            let stmt = stmt.as_ptr();
            // SAFETY: a live statement under the connection's lock. Reset's code repeats the
            // last step's error, which was already reported; it is ignored here as node does.
            unsafe {
                ffi::sqlite3_reset(stmt);
                ffi::sqlite3_clear_bindings(stmt);
            }
            for (offset, value) in params.iter().enumerate() {
                let Some(value) = value else { continue };
                let index = c_int::try_from(offset + 1)
                    .map_err(|_| own(ErrorKind::Sqlite, "too many parameters"))?;
                // SAFETY: a live statement; text and blob bytes are copied by SQLite
                // (SQLITE_TRANSIENT) before the call returns.
                let rc = unsafe {
                    match value {
                        Value::Null => ffi::sqlite3_bind_null(stmt, index),
                        Value::Integer(n) => ffi::sqlite3_bind_int64(stmt, index, *n),
                        Value::Real(n) => ffi::sqlite3_bind_double(stmt, index, *n),
                        Value::Text(text) => ffi::sqlite3_bind_text64(
                            stmt,
                            index,
                            text.as_ptr().cast(),
                            text.len() as u64,
                            ffi::SQLITE_TRANSIENT(),
                            ffi::SQLITE_UTF8 as u8,
                        ),
                        Value::Blob(bytes) if bytes.is_empty() => {
                            ffi::sqlite3_bind_zeroblob(stmt, index, 0)
                        }
                        Value::Blob(bytes) => ffi::sqlite3_bind_blob64(
                            stmt,
                            index,
                            bytes.as_ptr().cast(),
                            bytes.len() as u64,
                            ffi::SQLITE_TRANSIENT(),
                        ),
                    }
                };
                if rc != ffi::SQLITE_OK {
                    return Err(last_error(db, rc));
                }
            }
            Ok(())
        })
    }

    /// Step once: the next row's values, or None when the statement is done.
    pub fn step(&self) -> Result<Option<Vec<Value>>> {
        self.with(|db, stmt| {
            let stmt = stmt.as_ptr();
            // SAFETY: a live statement under the connection's lock.
            let rc = unsafe { ffi::sqlite3_step(stmt) };
            if rc == ffi::SQLITE_DONE {
                return Ok(None);
            }
            if rc != ffi::SQLITE_ROW {
                let error = last_error(db, rc);
                // SAFETY: as above; a failed statement is reset so it can run again.
                unsafe { ffi::sqlite3_reset(stmt) };
                return Err(error);
            }
            // SAFETY: as above, on the row just stepped to. Text and blob pointers are valid
            // until the next step or reset and are copied at once.
            let count = unsafe { ffi::sqlite3_column_count(stmt) };
            let mut row = Vec::with_capacity(usize::try_from(count).unwrap_or(0));
            for index in 0..count {
                let value = unsafe {
                    match ffi::sqlite3_column_type(stmt, index) {
                        ffi::SQLITE_INTEGER => {
                            Value::Integer(ffi::sqlite3_column_int64(stmt, index))
                        }
                        ffi::SQLITE_FLOAT => Value::Real(ffi::sqlite3_column_double(stmt, index)),
                        ffi::SQLITE_TEXT => {
                            let text = ffi::sqlite3_column_text(stmt, index);
                            let length = usize::try_from(ffi::sqlite3_column_bytes(stmt, index))
                                .unwrap_or(0);
                            if text.is_null() {
                                Value::Text(String::new())
                            } else {
                                let bytes = std::slice::from_raw_parts(text, length);
                                Value::Text(String::from_utf8_lossy(bytes).into_owned())
                            }
                        }
                        ffi::SQLITE_BLOB => {
                            let blob = ffi::sqlite3_column_blob(stmt, index);
                            let length = usize::try_from(ffi::sqlite3_column_bytes(stmt, index))
                                .unwrap_or(0);
                            if blob.is_null() || length == 0 {
                                Value::Blob(Vec::new())
                            } else {
                                Value::Blob(
                                    std::slice::from_raw_parts(blob.cast::<u8>(), length).to_vec(),
                                )
                            }
                        }
                        _ => Value::Null,
                    }
                };
                row.push(value);
            }
            Ok(Some(row))
        })
    }

    /// Reset so the next step starts again; keeps bindings. Reset finishes a statement
    /// stopped before its end, so its result is checked: a write with RETURNING commits
    /// there in autocommit mode, and a commit that fails (busy, I/O) fails the reset.
    pub fn reset(&self) -> Result<()> {
        self.with(|db, stmt| {
            // SAFETY: a live statement under the connection's lock.
            let rc = unsafe { ffi::sqlite3_reset(stmt.as_ptr()) };
            if rc == ffi::SQLITE_OK {
                Ok(())
            } else {
                Err(last_error(db, rc))
            }
        })
    }

    /// Rows changed by the connection's last statement, and the last inserted rowid.
    pub fn changes(&self) -> Result<(i64, i64)> {
        self.with(|db, _| {
            // SAFETY: a valid handle under the lock.
            Ok(unsafe {
                (
                    ffi::sqlite3_changes64(db.as_ptr()),
                    ffi::sqlite3_last_insert_rowid(db.as_ptr()),
                )
            })
        })
    }
}

impl Drop for Statement {
    fn drop(&mut self) {
        if let Some(raw) = self.connection.lock().as_mut()
            && let Some(stmt) = raw.statements.remove(&self.id)
        {
            // SAFETY: removed from the map, so finalized exactly once.
            unsafe { ffi::sqlite3_finalize(stmt.as_ptr()) };
        }
    }
}
