// SPDX-License-Identifier: Apache-2.0
//! Identity, group probes and tree stops. Group and member signals here
//! are unguarded primitives: the shell's `killGroup` runs its guard first.

use super::{bind_error, guarded, input_error, members_json, parse_members, quote};
use ace_supervisor::signal::{self, SignalName, SignalOutcome, TreeRef};
use ace_supervisor::system::{SystemSignalIo, SystemTree};
use ace_supervisor::{identity, stop, tree};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

fn tree_refs(members_json: &str) -> napi::Result<Vec<TreeRef>> {
    Ok(parse_members(members_json)?
        .into_iter()
        .map(|member| TreeRef {
            pid: member.pid,
            start: member.start,
        })
        .collect())
}

/// One process's kernel identity as JSON, or null when it is gone.
#[napi(catch_unwind)]
pub fn supervisor_process_identity(pid: u32) -> napi::Result<Option<String>> {
    guarded("supervisor identity", || {
        let found = identity::process_identity(pid).map_err(bind_error)?;
        Ok(found.map(|identity| {
            let owner = match identity.owner {
                identity::ProcessOwner::Uid(uid) => uid.to_string(),
                identity::ProcessOwner::Sid(sid) => quote(&sid),
            };
            format!(
                "{{\"pid\":{},\"start\":{},\"uid\":{},\"group\":{}}}",
                identity.pid,
                quote(&identity.start),
                owner,
                identity.group
            )
        }))
    })
}

/// Whether a process group is gone: ESRCH proves it; other refusals throw.
#[napi(catch_unwind)]
pub fn supervisor_process_group_is_gone(group: u32) -> napi::Result<bool> {
    guarded("supervisor group probe", || {
        identity::process_group_is_gone(group).map_err(bind_error)
    })
}

/// Ends a group with `signal`. Unguarded: only the shell's `killGroup`
/// calls it, after its guard allowed the whole group.
#[napi(catch_unwind)]
pub fn supervisor_kill_group(group: u32, signal: String) -> napi::Result<()> {
    guarded("supervisor kill group", || {
        let signal = SignalName::parse(&signal).map_err(bind_error)?;
        stop::kill_group(group, signal).map_err(bind_error)
    })
}

/// Signals one member, checked on its own just before the signal goes.
#[napi(catch_unwind)]
pub fn supervisor_signal_member(member_json: String, signal: String) -> napi::Result<String> {
    guarded("supervisor signal member", || {
        let member: super::MemberJson = serde_json::from_str(&member_json).map_err(input_error)?;
        let signal = SignalName::parse(&signal).map_err(bind_error)?;
        let outcome = signal::signal_member(
            &TreeRef {
                pid: member.pid,
                start: member.start,
            },
            signal,
            &SystemSignalIo,
        );
        Ok(match outcome {
            SignalOutcome::Sent => "sent",
            SignalOutcome::Gone => "gone",
            SignalOutcome::Unsafe => "unsafe",
        }
        .to_owned())
    })
}

/// Captures the tree below `roots` as JSON.
#[napi(catch_unwind)]
pub fn supervisor_capture_tree(roots_json: String, limit: f64) -> napi::Result<String> {
    guarded("supervisor capture tree", || {
        let roots: Vec<u32> = serde_json::from_str(&roots_json).map_err(input_error)?;
        let capture = tree::capture_tree(&roots, &SystemTree::new(), limit.max(0.0) as usize);
        let members: Vec<String> = capture
            .members
            .iter()
            .map(|member| {
                format!(
                    "{{\"pid\":{},\"start\":{},\"parent\":{},\"group\":{}}}",
                    member.pid,
                    quote(&member.start),
                    member.parent,
                    member.group
                )
            })
            .collect();
        Ok(format!(
            "{{\"members\":[{}],\"truncated\":{}}}",
            members.join(","),
            capture.truncated
        ))
    })
}

/// Stops captured members (SIGTERM, then SIGKILL) on a thread; `done`
/// hears the members still running as JSON. `deadline_ms` is wall-clock.
#[napi(catch_unwind)]
pub fn supervisor_stop_members(
    members: String,
    grace_ms: f64,
    deadline_ms: Option<f64>,
    done: ThreadsafeFunction<String>,
) -> napi::Result<()> {
    guarded("supervisor stop members", || {
        let members = tree_refs(&members)?;
        let deadline = deadline_ms.map(|at| {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_millis() as f64)
                .unwrap_or(0.0);
            std::time::Instant::now() + std::time::Duration::from_millis((at - now).max(0.0) as u64)
        });
        let grace = grace_ms.max(0.0) as u64;
        // The thread owns the wait; the JS thread never blocks on it.
        std::thread::spawn(move || {
            let left = tree::stop_members(&members, grace, &SystemTree::new(), deadline);
            let _ = done.call(
                Ok(members_json(
                    left.iter()
                        .map(|member| (member.pid, member.start.as_str())),
                )),
                ThreadsafeFunctionCallMode::NonBlocking,
            );
        });
        Ok(())
    })
}

/// The recorded Windows tree's state now, as JSON. Elsewhere empty.
#[napi(catch_unwind)]
pub fn supervisor_tree_state(recorded_json: String) -> napi::Result<String> {
    guarded("supervisor tree state", || {
        let recorded = parse_members(&recorded_json)?;
        #[cfg(windows)]
        {
            use ace_supervisor::wintree::{SystemWindowsTree, WindowsRecord, WindowsTreeOps as _};
            let members: Vec<WindowsRecord> = recorded
                .into_iter()
                .map(|member| WindowsRecord {
                    pid: member.pid,
                    start: member.start,
                    uid: member.uid,
                })
                .collect();
            let state = SystemWindowsTree::new()
                .state(&members)
                .map_err(bind_error)?;
            let ambiguous: Vec<String> = state.ambiguous.iter().map(u32::to_string).collect();
            Ok(format!(
                "{{\"live\":{},\"discovered\":{},\"gone\":{},\"ambiguous\":[{}]}}",
                records_json(&state.live),
                records_json(&state.discovered),
                records_json(&state.gone),
                ambiguous.join(",")
            ))
        }
        #[cfg(not(windows))]
        {
            let _ = recorded;
            Ok("{\"live\":[],\"discovered\":[],\"gone\":[],\"ambiguous\":[]}".to_owned())
        }
    })
}

#[cfg(windows)]
fn records_json(members: &[ace_supervisor::wintree::WindowsRecord]) -> String {
    let rows: Vec<String> = members
        .iter()
        .map(|member| {
            format!(
                "{{\"pid\":{},\"start\":{},\"uid\":{}}}",
                member.pid,
                quote(&member.start),
                quote(&member.uid)
            )
        })
        .collect();
    format!("[{}]", rows.join(","))
}

/// Ends one recorded Windows member; returns what it did.
#[napi(catch_unwind)]
pub fn supervisor_tree_terminate(member_json: String) -> napi::Result<String> {
    guarded("supervisor tree terminate", || {
        let member: super::MemberJson = serde_json::from_str(&member_json).map_err(input_error)?;
        #[cfg(windows)]
        {
            use ace_supervisor::wintree::{
                SystemWindowsTree, WindowsRecord, WindowsTerminate, WindowsTreeOps as _,
            };
            let outcome = SystemWindowsTree::new()
                .terminate(&WindowsRecord {
                    pid: member.pid,
                    start: member.start,
                    uid: member.uid,
                })
                .map_err(bind_error)?;
            Ok(match outcome {
                WindowsTerminate::Ended => "ended",
                WindowsTerminate::Gone => "gone",
            }
            .to_owned())
        }
        #[cfg(not(windows))]
        {
            let _ = member;
            Ok("gone".to_owned())
        }
    })
}
