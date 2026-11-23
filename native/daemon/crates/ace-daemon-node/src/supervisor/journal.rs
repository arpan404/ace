// SPDX-License-Identifier: Apache-2.0
//! The escapee journal behind a handle the shell holds, and the read-only
//! journal reads `ace stop` makes.

use super::{bind_error, guarded, members_json, parse_members, quote};
use ace_supervisor::journal::{self, EscapeeJournal, JournalMember};
use ace_supervisor::recover;
use napi_derive::napi;
use std::sync::Mutex;

fn journal_members(members_json: &str) -> napi::Result<Vec<JournalMember>> {
    Ok(parse_members(members_json)?
        .into_iter()
        .map(|member| JournalMember {
            pid: member.pid,
            start: member.start,
        })
        .collect())
}

fn listed(members: &[JournalMember]) -> String {
    members_json(
        members
            .iter()
            .map(|member| (member.pid, member.start.as_str())),
    )
}

#[napi]
pub struct NativeJournal {
    inner: Mutex<EscapeeJournal>,
}

#[napi]
impl NativeJournal {
    /// Opens (creating) the journal at `path` for `run`.
    #[napi(constructor, catch_unwind)]
    pub fn new(path: String, run: String) -> napi::Result<Self> {
        guarded("supervisor journal open", || {
            let inner = EscapeeJournal::open(&path, &run).map_err(bind_error)?;
            Ok(Self {
                inner: Mutex::new(inner),
            })
        })
    }

    fn with<T>(&self, run: impl FnOnce(&EscapeeJournal) -> napi::Result<T>) -> napi::Result<T> {
        guarded("supervisor journal", || {
            let inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("supervisor journal lock failed"))?;
            run(&inner)
        })
    }

    #[napi(catch_unwind)]
    pub fn record(&self, members_json: String) -> napi::Result<()> {
        self.with(|inner| {
            inner
                .record(&journal_members(&members_json)?)
                .map_err(bind_error)
        })
    }

    #[napi(catch_unwind)]
    pub fn forget(&self, members_json: String) -> napi::Result<()> {
        self.with(|inner| {
            inner
                .forget(&journal_members(&members_json)?)
                .map_err(bind_error)
        })
    }

    #[napi(catch_unwind)]
    pub fn earlier(&self) -> napi::Result<String> {
        self.with(|inner| {
            let rows = inner.earlier().map_err(bind_error)?;
            let rows: Vec<String> = rows
                .iter()
                .map(|row| {
                    format!(
                        "{{\"pid\":{},\"start\":{},\"run\":{}}}",
                        row.pid,
                        quote(&row.start),
                        quote(&row.run)
                    )
                })
                .collect();
            Ok(format!("[{}]", rows.join(",")))
        })
    }

    #[napi(catch_unwind)]
    pub fn keep(&self, pid: u32, start: String) -> napi::Result<()> {
        self.with(|inner| {
            inner
                .keep(&JournalMember { pid, start }, &|_pid| true)
                .map_err(bind_error)
        })
    }

    #[napi(catch_unwind)]
    pub fn record_lineage(&self, uniques: Vec<String>) -> napi::Result<()> {
        self.with(|inner| inner.record_lineage(&uniques).map_err(bind_error))
    }

    #[napi(catch_unwind)]
    pub fn forget_earlier_lineage(&self) -> napi::Result<()> {
        self.with(|inner| inner.forget_earlier_lineage().map_err(bind_error))
    }

    #[napi(catch_unwind)]
    pub fn kept(&self) -> napi::Result<String> {
        self.with(|inner| Ok(listed(&inner.kept().map_err(bind_error)?)))
    }

    #[napi(catch_unwind)]
    pub fn close(&self) -> napi::Result<()> {
        self.with(|inner| inner.close().map_err(bind_error))
    }
}

/// Read-only, for `ace stop`: a run's escapees, kept processes and lineage.
#[napi(catch_unwind)]
pub fn supervisor_read_ownership(path: String, run: Option<String>) -> napi::Result<String> {
    guarded("supervisor read ownership", || {
        let ownership = journal::read_ownership(&path, run.as_deref()).map_err(bind_error)?;
        let lineage: Vec<String> = ownership
            .lineage
            .iter()
            .map(|unique| quote(unique))
            .collect();
        Ok(format!(
            "{{\"escapees\":{},\"kept\":{},\"lineage\":[{}]}}",
            listed(&ownership.escapees),
            listed(&ownership.kept),
            lineage.join(",")
        ))
    })
}

/// Read-only, for `ace stop`: what the inventory records as owned by one
/// daemon run, by pid and start.
#[napi(catch_unwind)]
pub fn supervisor_read_owned_groups(
    path: String,
    owner_pid: u32,
    owner_start: String,
) -> napi::Result<String> {
    guarded("supervisor read owned groups", || {
        let owned =
            recover::read_owned_groups(&path, owner_pid, &owner_start).map_err(bind_error)?;
        Ok(members_json(
            owned.iter().map(|(pid, start)| (*pid, start.as_str())),
        ))
    })
}

/// Whether a journal still records the tree a leader started. Windows only.
#[napi(catch_unwind)]
pub fn supervisor_windows_tree_recorded(path: String, leader_json: String) -> napi::Result<bool> {
    guarded("supervisor tree recorded", || {
        let leader: super::MemberJson =
            serde_json::from_str(&leader_json).map_err(super::input_error)?;
        #[cfg(windows)]
        {
            recover::windows_tree_recorded(&path, leader.pid, &leader.start).map_err(bind_error)
        }
        #[cfg(not(windows))]
        {
            let _ = (path, leader);
            Ok(false)
        }
    })
}
