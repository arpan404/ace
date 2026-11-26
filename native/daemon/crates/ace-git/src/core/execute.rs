// SPDX-License-Identifier: Apache-2.0
//! Running one Git command directly (`GitCli.executeRaw` in `cli.ts`): the
//! environment, `--no-pager`, capture bounds, deadlines, cancellation,
//! stdin, streaming and cleanup receipts (G2a).

use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use ace_json::{JsString, Map, Number, Value};
use tokio::sync::Notify;

use crate::core::cancel::CallCancel;
use crate::core::capture::{concat_chunks, output_tail};
use crate::core::cli::DEFAULT_CAPTURE_BYTES;
use crate::core::cli::GitCliCore;
use crate::core::diagnostics::GitDiagnostics;
use crate::core::error::{CleanupResult, GitError, GitErrorCode, json_string_array};
use crate::core::execute_types::{
    CleanupEntry, ExecuteRawOptions, ExecuteRawOutput, StdinCommand, StopReason,
};
use crate::core::failure::{StderrTail, failure_message};
use crate::core::hookless::{windows_hookless_args, windows_hookless_env, windows_long_paths_env};
use crate::core::job::GitJob;

/// Maximum raw stderr bytes retained in `Output.stderr` (64 KiB).
const STDERR_RAW_LIMIT: usize = 65_536;
use crate::core::spawn::{
    ProcessEvent, SchedulerAdapter, SpawnRequest, classify_spawn_error, drain_process_exit,
    group_gone, kill_tree,
};

impl GitCliCore {
    pub async fn execute_raw(
        self: &Arc<Self>,
        mut opts: ExecuteRawOptions,
        call_id: u64,
        cancel: Arc<CallCancel>,
    ) -> Result<ExecuteRawOutput, GitError> {
        if self.is_closed() {
            self.unregister_cancel(call_id);
            return Err(GitError::new(GitErrorCode::GitClosed, "Git service closed"));
        }
        if opts.aborted_before_dispatch || cancel.is_aborted() {
            self.unregister_cancel(call_id);
            return Err(GitError::new(
                GitErrorCode::GitCancelled,
                "Git operation cancelled before dispatch",
            ));
        }
        self.active_calls.fetch_add(1, Ordering::AcqRel);
        let res = self.execute_raw_inner(&mut opts, cancel, call_id).await;
        self.unregister_cancel(call_id);
        if self.active_calls.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.active_zero.notify_waiters();
        }
        res
    }

    async fn execute_raw_inner(
        self: &Arc<Self>,
        opts: &mut ExecuteRawOptions,
        cancel: Arc<CallCancel>,
        call_id: u64,
    ) -> Result<ExecuteRawOutput, GitError> {
        let binary = opts.binary.clone().unwrap_or_else(|| self.binary());
        let mut env_map: BTreeMap<String, String> =
            crate::core::spawn::git_environment((self.ports.environment)())
                .into_iter()
                .collect();
        env_map.insert("GIT_TERMINAL_PROMPT".to_owned(), "0".to_owned());
        env_map.insert("LC_ALL".to_owned(), "C".to_owned());
        if !opts.write {
            env_map.insert("GIT_OPTIONAL_LOCKS".to_owned(), "0".to_owned());
        }
        for (k, v) in &opts.env {
            env_map.insert(k.clone(), v.clone());
        }
        let mut effective_args = opts.args.clone();
        if self.ports.platform == "win32" {
            let hooks_dir = self.ports.hooks_dir.as_ref().map(|dir| dir());
            effective_args = windows_hookless_args(&effective_args, hooks_dir.as_deref());
            windows_hookless_env(&mut env_map, hooks_dir.as_deref());
            windows_long_paths_env(&mut env_map);
        }
        if opts.strip_askpass {
            env_map.remove("SSH_ASKPASS");
            env_map.insert("GIT_ASKPASS".to_owned(), String::new());
            env_map.insert("GIT_TERMINAL_PROMPT".to_owned(), "0".to_owned());
        }

        if cancel.is_aborted() {
            return Err(GitError::new(
                GitErrorCode::GitCancelled,
                "Git operation cancelled before dispatch",
            ));
        }

        let job = if self.ports.platform == "win32" && self.ports.cleanup_supervisor.is_none() {
            self.ports
                .job_ports
                .as_ref()
                .and_then(|jp| GitJob::prepare(Arc::clone(jp), Arc::clone(&self.stopped_jobs)))
        } else {
            None
        };

        let mut spawn_args = Vec::with_capacity(effective_args.len() + 1);
        spawn_args.push("--no-pager".to_owned());
        spawn_args.extend(effective_args.iter().cloned());

        let spawned = self
            .ports
            .spawner
            .spawn(SpawnRequest {
                command: binary.clone(),
                args: spawn_args,
                cwd: Some(opts.cwd.clone()),
                env: env_map.into_iter().collect(),
                detached: self.ports.platform != "win32",
                hide_window: true,
            })
            .await;
        let child = spawned.child;
        let events = spawned.events;
        let pid = child.pid();
        let contained = match (job, pid) {
            (Some(j), Some(p)) if j.adopt(p) => Some(Arc::new(j)),
            _ => None,
        };
        if let Some(p) = pid {
            self.ports.running_children.add(p);
            self.ports.notify_pid(p, true);
        }

        // Write static stdin (if any) and close stdin when not streaming.
        if let Some(bytes) = opts.input.take() {
            if !bytes.is_empty() {
                let _ = child.write_stdin(bytes);
            }
            child.end_stdin();
        } else if opts.stdin_rx.is_none() {
            child.end_stdin();
        }

        let deadline = opts.timeout_ms.unwrap_or(self.timeout_ms);
        let deadline_hit = Arc::new(AtomicBool::new(false));
        let budget_hit = Arc::new(AtomicBool::new(false));
        let timer_notify = Arc::new(Notify::new());

        let d_flag = Arc::clone(&deadline_hit);
        let d_notify = Arc::clone(&timer_notify);
        let cancel_deadline = self.ports.scheduler.schedule(
            deadline,
            Box::new(move || {
                d_flag.store(true, Ordering::Release);
                d_notify.notify_waiters();
            }),
        );

        let cancel_budget = opts.stop_after_ms.map(|ms| {
            let b_flag = Arc::clone(&budget_hit);
            let b_notify = Arc::clone(&timer_notify);
            self.ports.scheduler.schedule(
                ms,
                Box::new(move || {
                    b_flag.store(true, Ordering::Release);
                    b_notify.notify_waiters();
                }),
            )
        });

        let limit = opts.capture_bytes.unwrap_or(DEFAULT_CAPTURE_BYTES);
        let bounded = opts.stop_at_capture || opts.stop_after_ms.is_some() || opts.bounded;
        let mut stdout_chunks: Vec<Vec<u8>> = Vec::new();
        let mut stderr_raw: Vec<u8> = Vec::new();
        let mut captured: usize = 0;
        let mut truncated = false;
        let mut diagnostics = GitDiagnostics::new();
        let mut tail = StderrTail::new();
        let mut stdin_error: Option<String> = None;
        let mut stdin_finished = false;
        let mut spawn_error: Option<(Option<String>, String)> = None;
        let mut failure: Option<GitError> = None;
        let mut enough: Option<StopReason> = None;
        let mut close_result: Option<(Option<i32>, Option<String>)> = None;

        // Check immediate cancellation / close after spawn.
        if cancel.is_aborted() {
            failure = Some(GitError::new(
                GitErrorCode::GitCancelled,
                "Git operation cancelled",
            ));
        } else if cancel.is_closed() || self.is_closed() {
            failure = Some(GitError::new(GitErrorCode::GitClosed, "Git service closed"));
        }

        let mut stdin_rx = opts.stdin_rx.take();
        // Sizes of the writes not yet acknowledged, so each ack names its chunk.
        let mut stdin_written: VecDeque<usize> = VecDeque::new();

        while failure.is_none() && enough.is_none() && close_result.is_none() {
            // The timer registers before its flag is read, and `cancelled()`
            // registers before it reads abort and close, so neither wakeup is lost.
            let expired = timer_notify.notified();
            tokio::pin!(expired);
            expired.as_mut().enable();
            if deadline_hit.load(Ordering::Acquire) {
                failure = Some(
                    GitError::new(
                        GitErrorCode::GitTimeout,
                        format!("Git exceeded {deadline}ms"),
                    )
                    .with_detail("args", json_string_array(&effective_args)),
                );
                break;
            }
            if budget_hit.load(Ordering::Acquire) {
                enough = Some(StopReason::Budget);
                break;
            }
            if cancel.is_aborted() {
                failure = Some(GitError::new(
                    GitErrorCode::GitCancelled,
                    "Git operation cancelled",
                ));
                break;
            }
            if cancel.is_closed() || self.is_closed() {
                failure = Some(GitError::new(GitErrorCode::GitClosed, "Git service closed"));
                break;
            }

            tokio::select! {
                biased;
                _ = cancel.cancelled() => {}
                _ = &mut expired => {}
                cmd = async {
                    match stdin_rx.as_mut() {
                        Some(rx) => rx.recv().await,
                        None => std::future::pending().await,
                    }
                } => {
                    match cmd {
                        Some(StdinCommand::Write(bytes)) => {
                            let len = bytes.len();
                            if child.write_stdin(bytes).is_ok() {
                                stdin_written.push_back(len);
                            }
                        }
                        Some(StdinCommand::End) | None => {
                            stdin_rx = None;
                            child.end_stdin();
                        }
                        Some(StdinCommand::Error(err)) => {
                            stdin_rx = None;
                            failure = Some(err);
                        }
                    }
                }
                ev = events.recv() => match ev {
                    Some(ProcessEvent::Stdout(chunk)) => {
                        let bytes = chunk.bytes;
                        if opts.stream_stdout {
                            if let Some(ref cb) = opts.callbacks {
                                tokio::select! {
                                    biased;
                                    _ = cancel.cancelled() => {}
                                    _ = expired_stop(&deadline_hit, &budget_hit, &timer_notify) => {}
                                    res = cb.on_stdout(bytes) => {
                                        if let Err(err) = res {
                                            failure = Some(err);
                                        }
                                    }
                                }
                            }
                        } else {
                            let remaining = limit.saturating_sub(captured);
                            if remaining > 0 {
                                let take = remaining.min(bytes.len());
                                stdout_chunks.push(bytes[..take].to_vec());
                                captured += take;
                            }
                            if bytes.len() > remaining {
                                truncated = true;
                                if opts.capture_bytes.is_none() {
                                    failure = Some(
                                        GitError::new(
                                            GitErrorCode::OutputTooLarge,
                                            "Git metadata exceeded 64 MiB",
                                        )
                                        .with_detail("args", json_string_array(&effective_args)),
                                    );
                                }
                            }
                            if opts.stop_at_capture && captured >= limit && failure.is_none() && enough.is_none() {
                                truncated = true;
                                enough = Some(StopReason::Capture);
                            }
                        }
                    }
                    Some(ProcessEvent::Stderr(chunk)) => {
                        let bytes = chunk.bytes;
                        if opts.stream_stderr
                            && let Some(ref cb) = opts.callbacks
                        {
                            tokio::select! {
                                biased;
                                _ = cancel.cancelled() => {}
                                _ = expired_stop(&deadline_hit, &budget_hit, &timer_notify) => {}
                                res = cb.on_stderr(bytes.clone()) => {
                                    if let Err(err) = res {
                                        failure = Some(err);
                                    }
                                }
                            }
                        }
                        diagnostics.accept(&bytes);
                        tail.accept(&bytes);
                        let keep = bytes.len().min(STDERR_RAW_LIMIT.saturating_sub(stderr_raw.len()));
                        if keep > 0 {
                            stderr_raw.extend_from_slice(&bytes[..keep]);
                        }
                    }
                    Some(ProcessEvent::StdoutError { code, message })
                    | Some(ProcessEvent::StderrError { code, message }) => {
                        failure = Some(match code {
                            Some(errno) => GitError::filesystem(errno, message),
                            None => GitError::new(GitErrorCode::GitFailed, message),
                        });
                    }
                    Some(ProcessEvent::StdinError { message, .. }) => {
                        if stdin_error.is_none() {
                            stdin_error = Some(message);
                        }
                    }
                    Some(ProcessEvent::StdinFinish) => {
                        stdin_finished = true;
                    }
                    Some(ProcessEvent::StdinAck) => {
                        if let Some(bytes) = stdin_written.pop_front() {
                            self.ports.notify_stdin_ack(call_id, bytes);
                        }
                    }
                    Some(ProcessEvent::SpawnError { code, message }) => {
                        spawn_error = Some((code, message));
                    }
                    Some(ProcessEvent::Exit { pid: exit_pid, .. }) => {
                        if let Some(p) = exit_pid.or(pid) {
                            self.ports.running_children.remove(p);
                            self.ports.notify_pid(p, false);
                        }
                    }
                    Some(ProcessEvent::Close { code, signal }) => {
                        if let Some(p) = pid {
                            self.ports.running_children.remove(p);
                            self.ports.notify_pid(p, false);
                        }
                        close_result = Some((code, signal));
                    }
                    None => {
                        if let Some(p) = pid {
                            self.ports.running_children.remove(p);
                            self.ports.notify_pid(p, false);
                        }
                        close_result = Some((None, None));
                    }
                }
            }
        }

        // Handle signal termination on Close as a kill path (matching cli.ts:1155).
        if let Some((_, Some(sig))) = &close_result
            && spawn_error.is_none()
            && failure.is_none()
            && enough.is_none()
        {
            let mut details = Map::new();
            details.insert(JsString::from("signal"), Value::from(sig.as_str()));
            details.insert(JsString::from("stderr"), Value::String(tail.text()));
            failure = Some(GitError::with_details(
                GitErrorCode::GitFailed,
                "Git terminated by signal",
                details,
            ));
        }

        cancel_deadline.cancel();
        if let Some(cb) = cancel_budget {
            cb.cancel();
        }

        if failure.is_some() || enough.is_some() {
            if let Some(p) = pid {
                self.ports.running_children.remove(p);
                self.ports.notify_pid(p, false);
            }
            let drain_scheduler = Arc::clone(&self.ports.scheduler);
            let drain_child = Arc::clone(&child);
            let drain_handle = self.ports.runtime.spawn(async move {
                drain_process_exit(drain_scheduler.as_ref(), drain_child.as_ref()).await;
            });
            if let Ok(mut drains) = self.drains.lock() {
                drains.retain(|h| !h.is_finished());
                drains.push(drain_handle);
            }

            let (cleanup_id, cleanup_tx) = self.cleanups.register();
            let ports_clone = Arc::clone(&self.ports);
            let child_clone = Arc::clone(&child);
            let leases_json = opts.leases_json.clone();
            let contained_clone = contained.clone();

            self.ports.runtime.spawn(async move {
                let entry = if let Some(job) = contained_clone {
                    let adapter = SchedulerAdapter(Arc::clone(&ports_clone.scheduler));
                    let result = job.stop(&adapter).await;
                    CleanupEntry {
                        result,
                        group_pid: pid,
                    }
                } else if let Some(ref sup) = ports_clone.cleanup_supervisor
                    && let Some(spawn_id) = child_clone.spawn_id()
                {
                    match sup.stop(spawn_id, leases_json).await {
                        Ok(result) => CleanupEntry {
                            result,
                            group_pid: None,
                        },
                        Err(_) => {
                            kill_tree(&ports_clone, Arc::clone(&child_clone)).await;
                            CleanupEntry {
                                result: CleanupResult::Unconfirmed {
                                    reason: "Cleanup supervisor failed".to_owned(),
                                },
                                group_pid: None,
                            }
                        }
                    }
                } else {
                    let group_pid = if ports_clone.platform != "win32" {
                        pid
                    } else {
                        None
                    };
                    kill_tree(&ports_clone, Arc::clone(&child_clone)).await;
                    CleanupEntry {
                        result: CleanupResult::Unconfirmed {
                            reason: format!(
                                "No escaped-descendant containment on {}",
                                ports_clone.platform
                            ),
                        },
                        group_pid,
                    }
                };
                let _ = cleanup_tx.send(Some(entry));
            });

            let sync_group_pid = if contained.is_some() {
                pid
            } else if self.ports.cleanup_supervisor.is_some() && child.spawn_id().is_some() {
                None
            } else if self.ports.platform != "win32" {
                pid
            } else {
                None
            };

            if let Some(ref mut err) = failure {
                err.cleanup_id = Some(cleanup_id);
                err.cleanup_group_pid = sync_group_pid;
            }
            child.destroy();

            if let Some(reason) = enough
                && failure.is_none()
            {
                group_gone(&self.ports, child.as_ref(), 3_000).await;
                return Ok(ExecuteRawOutput {
                    stdout: concat_chunks(stdout_chunks),
                    stderr: String::from_utf8_lossy(&stderr_raw).into_owned(),
                    exit_code: 0,
                    truncated: true,
                    stopped: Some(reason),
                    cleanup_id: Some(cleanup_id),
                    cleanup_group_pid: sync_group_pid,
                });
            }
            if bounded {
                group_gone(&self.ports, child.as_ref(), 3_000).await;
            }
            return Err(failure
                .unwrap_or_else(|| GitError::new(GitErrorCode::GitFailed, "Git command failed")));
        }

        // Normal close path.
        if let Some(ref job) = contained {
            job.release();
        }
        if bounded
            && let Some(p) = pid
            && self.ports.platform != "win32"
        {
            if self.ports.group_alive(child.as_ref(), p).await {
                let _ = self.ports.signal_group(child.as_ref(), p, "SIGKILL").await;
            }
            group_gone(&self.ports, child.as_ref(), 3_000).await;
        }

        if let Some((code, msg)) = spawn_error {
            return Err(classify_spawn_error(
                code.as_deref(),
                &msg,
                &opts.cwd,
                &binary,
            ));
        }

        let code = close_result.and_then(|(c, _)| c);
        if code != Some(0) {
            diagnostics.accept_output(&output_tail(&stdout_chunks));
            let category = diagnostics.finish();
            if !opts.allow_failure
                || (opts.execution_disabled && category == GitErrorCode::ObjectsNotAvailable)
            {
                let mut details = Map::new();
                if let Some(c) = code {
                    details.insert(
                        JsString::from("code"),
                        Value::Number(Number::from(c as f64)),
                    );
                } else {
                    details.insert(JsString::from("code"), Value::Null);
                }
                details.insert(JsString::from("stderr"), Value::String(tail.text()));
                if let Some(ref lock) = diagnostics.lock_file {
                    details.insert(JsString::from("lock"), Value::from(lock.as_str()));
                }
                return Err(GitError::with_details(
                    category,
                    failure_message(category),
                    details,
                ));
            }
        }

        if code == Some(0) && opts.has_input && (stdin_error.is_some() || !stdin_finished) {
            let mut details = Map::new();
            details.insert(JsString::from("code"), Value::Number(Number::from(0.0)));
            details.insert(JsString::from("stderr"), Value::String(tail.text()));
            if let Some(ref cause) = stdin_error {
                details.insert(JsString::from("cause"), Value::from(cause.as_str()));
            }
            return Err(GitError::with_details(
                GitErrorCode::GitFailed,
                "Git stopped reading its input before the end",
                details,
            ));
        }

        Ok(ExecuteRawOutput {
            stdout: concat_chunks(stdout_chunks),
            stderr: String::from_utf8_lossy(&stderr_raw).into_owned(),
            exit_code: code.unwrap_or(-1),
            truncated,
            stopped: None,
            cleanup_id: None,
            cleanup_group_pid: None,
        })
    }
}

async fn expired_stop(deadline: &AtomicBool, budget: &AtomicBool, notify: &Notify) {
    crate::core::wake::wait_until(
        || deadline.load(Ordering::Acquire) || budget.load(Ordering::Acquire),
        notify,
    )
    .await;
}
