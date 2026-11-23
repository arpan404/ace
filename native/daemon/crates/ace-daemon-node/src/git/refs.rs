// SPDX-License-Identifier: Apache-2.0
//! The ref binding (G1): values in, bytes or `ace-json` text out, never logic — and never on
//! the JavaScript thread. Every read runs on this binding's own two-worker pool, so git work
//! can neither block the daemon's JavaScript thread nor take the addon's shared libuv pool
//! from other tasks. The shell aborts a read through a token the core polls, and the token
//! lives until the job actually ends, not until its caller stops waiting.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex, OnceLock};

use ace_git::refs::{self, Cancel, Outcome};
use napi::bindgen_prelude::{Either, Uint8Array};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

use super::unwind;

/// A read's answer: the bytes Git would print, or the `ace-json` text carrying either data
/// or the fallback reason. One shape settles every read's promise.
type Reply = Either<Uint8Array, String>;
/// The JavaScript callback that settles one read's promise, called as `(error, reply)`.
type Settle = ThreadsafeFunction<Reply>;

fn reply_of(outcome: Outcome<Vec<u8>>) -> Reply {
    match outcome {
        Outcome::Data(bytes) => Either::A(Uint8Array::new(bytes)),
        Outcome::Fallback(reason) => Either::B(reason.payload()),
    }
}

fn text_of(outcome: &Outcome<impl serde::Serialize>) -> napi::Result<Reply> {
    refs::reply(outcome)
        .map(Either::B)
        .map_err(|error| napi::Error::from_reason(format!("git_failed:{}", error.to_payload())))
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

impl ListingRequest {
    fn answer(self, cancel: &Cancel) -> napi::Result<Reply> {
        Ok(match self {
            Self::Worktrees(root) => reply_of(ace_git::worktrees_gix::worktrees(&root, cancel)),
            Self::Refs {
                root,
                patterns,
                count,
                short_names,
            } => reply_of(if short_names {
                refs::branch_names(&root, &patterns, count, cancel)
            } else {
                refs::branch_refs(&root, &patterns, count, cancel)
            }),
        })
    }
}

enum TextRequest {
    Commit { root: String, reference: String },
    BranchHead { root: String, reference: String },
}

impl TextRequest {
    fn answer(self, cancel: &Cancel) -> napi::Result<Reply> {
        match self {
            Self::Commit { root, reference } => {
                text_of(&refs::resolve_commit(&root, &reference, cancel))
            }
            Self::BranchHead { root, reference } => {
                text_of(&refs::branch_head(&root, &reference, cancel))
            }
        }
    }
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

/// The abort flag of one read, removed when its job ends.
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

/// One git read running on the pool.
type Job = Box<dyn FnOnce() + Send + 'static>;

/// A fixed pool, bounded by the shell's admission (the CLI's 64-call limit) and sized like the
/// CLI's own concurrency so many roots read at once: git reads never run on the JavaScript
/// thread and never queue on the shared libuv pool.
struct Pool {
    jobs: Sender<Job>,
}

fn pool() -> Option<&'static Pool> {
    static POOL: OnceLock<Pool> = OnceLock::new();
    if let Some(pool) = POOL.get() {
        return Some(pool);
    }
    let (jobs, inbox) = channel::<Job>();
    let inbox = Arc::new(Mutex::new(inbox));
    let workers = std::thread::available_parallelism()
        .map_or(2, |parallelism| parallelism.get())
        .clamp(2, 8);
    for worker in 0..workers {
        let inbox = Arc::clone(&inbox);
        let spawned = std::thread::Builder::new()
            .name(format!("ace-git-{worker}"))
            .spawn(move || {
                loop {
                    let job = match inbox.lock() {
                        Ok(inbox) => inbox.recv(),
                        Err(_) => return,
                    };
                    match job {
                        Ok(job) => job(),
                        // The pool's only sender lives as long as the process.
                        Err(_) => return,
                    }
                }
            });
        if spawned.is_err() {
            return None;
        }
    }
    let _ = POOL.set(Pool { jobs });
    POOL.get()
}

/// Runs `job` catching panics, as every binding export does.
fn guarded<T>(context: &'static str, run: impl FnOnce() -> napi::Result<T>) -> napi::Result<T> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(run)) {
        Ok(result) => result,
        Err(_) => Err(unwind(context)),
    }
}

/// Runs `job` on the pool and settles the caller's promise; the abort token is released when
/// the job ends, however long the caller waited for it.
fn submit(
    job: impl FnOnce() -> napi::Result<Reply> + Send + 'static,
    settle: Settle,
    pending: Pending,
) {
    let settle = Arc::new(settle);
    let Some(workers) = pool() else {
        let _ = settle.call(
            Err(pool_failed("the git worker pool did not start")),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
        return;
    };
    let finishing = Arc::clone(&settle);
    let sent = workers.jobs.send(Box::new(move || {
        match job() {
            Ok(reply) => {
                let _ = finishing.call(Ok(reply), ThreadsafeFunctionCallMode::NonBlocking);
            }
            Err(error) => {
                let _ = finishing.call(Err(error), ThreadsafeFunctionCallMode::NonBlocking);
            }
        }
        // Dropped here, not when the caller stops waiting.
        drop(pending);
    }));
    if sent.is_err() {
        let _ = settle.call(
            Err(pool_failed("the git worker pool stopped")),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
    }
}

fn pool_failed(reason: &str) -> napi::Error {
    napi::Error::from_reason(format!(
        "git_failed:{{\"code\":\"git_failed\",\"message\":\"{reason}\",\"details\":{{\"stub\":false}}}}"
    ))
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
pub fn git_refs_worktrees(token: u32, root: String, settle: Settle) -> napi::Result<()> {
    let pending = Pending::new(token);
    let cancel = pending.cancel.clone();
    submit(
        move || {
            guarded("git refs worktrees", || {
                ListingRequest::Worktrees(root).answer(&cancel)
            })
        },
        settle,
        pending,
    );
    Ok(())
}

#[napi]
pub fn git_refs_branch_listing(
    token: u32,
    root: String,
    patterns: Vec<String>,
    count: u32,
    settle: Settle,
) -> napi::Result<()> {
    let pending = Pending::new(token);
    let cancel = pending.cancel.clone();
    let request = ListingRequest::Refs {
        root,
        patterns,
        count,
        short_names: false,
    };
    submit(
        move || guarded("git refs branch listing", || request.answer(&cancel)),
        settle,
        pending,
    );
    Ok(())
}

#[napi]
pub fn git_refs_branch_names(
    token: u32,
    root: String,
    patterns: Vec<String>,
    count: u32,
    settle: Settle,
) -> napi::Result<()> {
    let pending = Pending::new(token);
    let cancel = pending.cancel.clone();
    let request = ListingRequest::Refs {
        root,
        patterns,
        count,
        short_names: true,
    };
    submit(
        move || guarded("git refs branch names", || request.answer(&cancel)),
        settle,
        pending,
    );
    Ok(())
}

#[napi]
pub fn git_refs_commit(
    token: u32,
    root: String,
    reference: String,
    settle: Settle,
) -> napi::Result<()> {
    let pending = Pending::new(token);
    let cancel = pending.cancel.clone();
    let request = TextRequest::Commit { root, reference };
    submit(
        move || guarded("git refs commit", || request.answer(&cancel)),
        settle,
        pending,
    );
    Ok(())
}

#[napi]
pub fn git_refs_branch_head(
    token: u32,
    root: String,
    reference: String,
    settle: Settle,
) -> napi::Result<()> {
    let pending = Pending::new(token);
    let cancel = pending.cancel.clone();
    let request = TextRequest::BranchHead { root, reference };
    submit(
        move || guarded("git refs branch head", || request.answer(&cancel)),
        settle,
        pending,
    );
    Ok(())
}
