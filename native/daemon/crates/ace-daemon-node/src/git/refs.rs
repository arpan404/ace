// SPDX-License-Identifier: Apache-2.0
//! The ref binding (G1): values in, bytes or `ace-json` text out, never logic — and never on
//! the JavaScript thread. Every read runs on a worker thread and answers a promise; the shell
//! aborts it through a token this module polls, so an aborted or timed-out read stops early
//! instead of stalling the daemon or a worker to the end.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use ace_git::refs::{self, Cancel, Outcome};
use napi::bindgen_prelude::{AsyncTask, Buffer, Either, Task};
use napi::{Env, Result as NapiResult};
use napi_derive::napi;

use super::caught;

/// A listing's result on its way to JavaScript.
pub enum Listing {
    Bytes(Vec<u8>),
    Refused(String),
}

impl Listing {
    fn of(outcome: Outcome<Vec<u8>>) -> Self {
        match outcome {
            Outcome::Data(bytes) => Self::Bytes(bytes),
            Outcome::Fallback(reason) => Self::Refused(reason.payload()),
        }
    }
}

enum ListingRequest {
    Worktrees(String),
    Refs {
        root: String,
        patterns: Vec<String>,
        count: u32,
        short_names: bool,
    },
}

enum TextRequest {
    Commit { root: String, reference: String },
    BranchHead { root: String, reference: String },
}

/// The abort flags of the reads in flight, by the token the shell holds.
struct Aborts {
    next: AtomicU32,
    flags: Mutex<HashMap<u32, Arc<AtomicBool>>>,
}

impl Aborts {
    fn register(&self) -> u32 {
        let token = self.next.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut flags) = self.flags.lock() {
            flags.insert(token, Arc::new(AtomicBool::new(false)));
        }
        token
    }

    fn abort(&self, token: u32) {
        if let Ok(flags) = self.flags.lock()
            && let Some(flag) = flags.get(&token)
        {
            flag.store(true, Ordering::Relaxed);
        }
    }

    fn cancel(&self, token: u32) -> Cancel {
        match self.flags.lock() {
            Ok(flags) => flags
                .get(&token)
                .map_or_else(Cancel::never, |flag| Cancel::new(Arc::clone(flag))),
            Err(_) => Cancel::never(),
        }
    }

    fn release(&self, token: u32) {
        if let Ok(mut flags) = self.flags.lock() {
            flags.remove(&token);
        }
    }
}

fn aborts() -> &'static Aborts {
    static ABORTS: OnceLock<Aborts> = OnceLock::new();
    ABORTS.get_or_init(|| Aborts {
        next: AtomicU32::new(1),
        flags: Mutex::new(HashMap::new()),
    })
}

/// What one read needs of its abort token: the flag it polls, and its own removal.
struct Pending {
    token: u32,
    cancel: Cancel,
}

impl Pending {
    fn new(token: u32) -> Self {
        Self {
            token,
            cancel: aborts().cancel(token),
        }
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        aborts().release(self.token);
    }
}

/// A listing running on a worker thread.
pub struct ListingTask {
    pending: Pending,
    request: ListingRequest,
}

impl Task for ListingTask {
    type Output = Listing;
    type JsValue = Either<Buffer, String>;

    fn compute(&mut self) -> NapiResult<Self::Output> {
        caught("git refs listing", || {
            Ok(match &self.request {
                ListingRequest::Worktrees(root) => Listing::of(ace_git::worktrees_gix::worktrees(
                    root,
                    &self.pending.cancel,
                )),
                ListingRequest::Refs {
                    root,
                    patterns,
                    count,
                    short_names,
                } => Listing::of(if *short_names {
                    refs::branch_names(root, patterns, *count, &self.pending.cancel)
                } else {
                    refs::branch_refs(root, patterns, *count, &self.pending.cancel)
                }),
            })
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> NapiResult<Self::JsValue> {
        Ok(match output {
            Listing::Bytes(bytes) => Either::A(Buffer::from(bytes)),
            Listing::Refused(payload) => Either::B(payload),
        })
    }
}

/// A `rev-parse` answer running on a worker thread.
pub struct TextTask {
    pending: Pending,
    request: TextRequest,
}

impl Task for TextTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> NapiResult<Self::Output> {
        caught("git refs text", || match &self.request {
            TextRequest::Commit { root, reference } => {
                refs::reply(&refs::resolve_commit(root, reference, &self.pending.cancel))
            }
            TextRequest::BranchHead { root, reference } => {
                refs::reply(&refs::branch_head(root, reference, &self.pending.cancel))
            }
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> NapiResult<Self::JsValue> {
        Ok(output)
    }
}

/// Register an abort token for one read.
#[napi]
pub fn git_refs_abort_token() -> u32 {
    aborts().register()
}

/// Abort the read holding `token`; its worker stops at the next poll.
#[napi]
pub fn git_refs_abort(token: u32) {
    aborts().abort(token);
}

#[napi]
pub fn git_refs_worktrees(token: u32, root: String) -> AsyncTask<ListingTask> {
    AsyncTask::new(ListingTask {
        pending: Pending::new(token),
        request: ListingRequest::Worktrees(root),
    })
}

#[napi]
pub fn git_refs_branch_listing(
    token: u32,
    root: String,
    patterns: Vec<String>,
    count: u32,
) -> AsyncTask<ListingTask> {
    AsyncTask::new(ListingTask {
        pending: Pending::new(token),
        request: ListingRequest::Refs {
            root,
            patterns,
            count,
            short_names: false,
        },
    })
}

#[napi]
pub fn git_refs_branch_names(
    token: u32,
    root: String,
    patterns: Vec<String>,
    count: u32,
) -> AsyncTask<ListingTask> {
    AsyncTask::new(ListingTask {
        pending: Pending::new(token),
        request: ListingRequest::Refs {
            root,
            patterns,
            count,
            short_names: true,
        },
    })
}

#[napi]
pub fn git_refs_commit(token: u32, root: String, reference: String) -> AsyncTask<TextTask> {
    AsyncTask::new(TextTask {
        pending: Pending::new(token),
        request: TextRequest::Commit { root, reference },
    })
}

#[napi]
pub fn git_refs_branch_head(token: u32, root: String, reference: String) -> AsyncTask<TextTask> {
    AsyncTask::new(TextTask {
        pending: Pending::new(token),
        request: TextRequest::BranchHead { root, reference },
    })
}
