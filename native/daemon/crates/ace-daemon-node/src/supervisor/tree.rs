// SPDX-License-Identifier: Apache-2.0
//! Identity, group probes and tree stops. Group and member signals here
//! are unguarded primitives: the shell's `killGroup` runs its guard first.

use super::{bind_error, guarded, input_error, members_json, parse_members, quote};
use ace_supervisor::signal::{self, SignalName, SignalOutcome, TreeRef};
use ace_supervisor::system::{SystemSignalIo, SystemTree};
use ace_supervisor::{identity, tree};
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

/// Starts a stop of the group led by `group` with kernel start `start`:
/// true while its id is provably the tree that leader started. A leader
/// this supervisor holds stays unreaped until `supervisor_unhold_group`;
/// any other must be alive with that identity, leading `group`.
#[napi(catch_unwind)]
pub fn supervisor_hold_group(group: u32, start: String) -> napi::Result<bool> {
    guarded("supervisor hold group", || {
        if let Some(leader) = ace_supervisor::leader::group_leader(group, &start) {
            return Ok(leader.hold());
        }
        Ok(identity::process_identity(group)
            .ok()
            .flatten()
            .is_some_and(|leader| leader.start == start && leader.group == group))
    })
}

/// Ends a stop started with `supervisor_hold_group`.
#[napi(catch_unwind)]
pub fn supervisor_unhold_group(group: u32, start: String) -> napi::Result<()> {
    guarded("supervisor unhold group", || {
        if let Some(leader) = ace_supervisor::leader::group_leader(group, &start) {
            leader.unhold();
        }
        Ok(())
    })
}

/// Signals the group led by (`group`, `start`). Unguarded: only the shell's
/// `killGroup` calls it, inside a hold and after its guard allowed the whole
/// group. A leader this supervisor holds unreaped: by number. A group it does
/// not hold: never by number, but each member verified now (its leader alive
/// with `start`), one by one, rechecked just before (a Linux pidfd pins it).
/// A released leader: `"released"`, nothing sent (the shell signals its
/// recorded members, `supervisor_group_members`).
#[napi(catch_unwind)]
pub fn supervisor_signal_group(group: u32, start: String, signal: String) -> napi::Result<String> {
    guarded("supervisor signal group", || {
        let signal = SignalName::parse(&signal).map_err(bind_error)?;
        #[cfg(unix)]
        {
            use ace_supervisor::leader::GroupSignal;
            let outcome = match ace_supervisor::leader::group_leader(group, &start) {
                Some(leader) => leader.signal_group(signal).map_err(bind_error)?,
                None => {
                    let members = ace_supervisor::system::verified_group_members(group, &start);
                    if members.is_empty() {
                        GroupSignal::Released
                    } else {
                        // Every member is signalled; none is skipped once one went.
                        let mut sent = false;
                        for member in &members {
                            sent |= signal::signal_member(member, signal, &SystemSignalIo)
                                == SignalOutcome::Sent;
                        }
                        if sent {
                            GroupSignal::Sent
                        } else {
                            GroupSignal::Gone
                        }
                    }
                }
            };
            Ok(match outcome {
                GroupSignal::Sent => "sent",
                GroupSignal::Gone => "gone",
                GroupSignal::Released => "released",
            }
            .to_owned())
        }
        #[cfg(not(unix))]
        {
            let _ = (group, start, signal);
            Err(napi::Error::from_reason(
                "process groups do not exist on Windows",
            ))
        }
    })
}

/// What a stop of the group led by (`group`, `start`) may signal one by one
/// once the group number may not be: a released leader's recorded members
/// that still run and the children they prove; for a group this supervisor
/// does not hold, its members and the leader's tree while that leader is
/// verified alive; otherwise none. As JSON `[{pid, start}]`.
#[napi(catch_unwind)]
pub fn supervisor_group_members(group: u32, start: String) -> napi::Result<String> {
    guarded("supervisor group members", || {
        let members = match ace_supervisor::leader::group_leader(group, &start) {
            Some(leader) => leader.members(),
            None => ace_supervisor::system::verified_group_members(group, &start),
        };
        Ok(members_json(
            members
                .iter()
                .map(|member| (member.pid, member.start.as_str())),
        ))
    })
}

/// The shell gave up the group led by (`group`, `start`): a held leader is
/// released once it exited and no stop holds it.
#[napi(catch_unwind)]
pub fn supervisor_disown_group(group: u32, start: String) -> napi::Result<()> {
    guarded("supervisor disown group", || {
        if let Some(leader) = ace_supervisor::leader::group_leader(group, &start) {
            leader.disown();
        }
        Ok(())
    })
}

/// Whether nothing of the group runs. A leader this supervisor holds
/// answers by a full scan (its zombie and unreadable members as it says);
/// any other group by the kernel's probe, with `killGroup`'s meaning
/// (ESRCH, or darwin's EPERM for a group of zombies). Probes send nothing.
#[napi(catch_unwind)]
pub fn supervisor_group_gone(group: u32, start: Option<String>) -> napi::Result<bool> {
    guarded("supervisor group gone", || {
        if let Some(leader) = start
            .as_deref()
            .and_then(|start| ace_supervisor::leader::group_leader(group, start))
        {
            return Ok(leader.group_gone());
        }
        match ace_supervisor::reaper::process_group_alive(group) {
            Ok(alive) => Ok(!alive),
            Err(ace_supervisor::errors::SupervisorError::Unavailable(message)) => {
                if cfg!(target_os = "macos") {
                    Ok(true)
                } else {
                    Err(napi::Error::from_reason(message))
                }
            }
            Err(error) => Err(bind_error(error)),
        }
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
