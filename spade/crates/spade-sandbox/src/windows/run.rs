//! Starting one of a bot's commands inside its AppContainer and job on Windows (ADR 0167
//! decision 1). As on Linux, the daemon spawns Spade's own binary as a launcher
//! (`spade sandbox-exec-win <plan> <program> <args>…`) with the command's stdio piped; the
//! launcher reads the plan and calls into `spade-sandbox-windows`, which creates the command in
//! the container, holds it in a job and waits. Applying the ACLs and setting up the egress bridge
//! are the daemon's, before the launch ([`super::acls`] and the proxy).

use std::ffi::OsString;

use super::Plan;

/// The launcher's first argument.
pub const LAUNCHER_ARG: &str = "sandbox-exec-win";

/// Default job limits (ADR 0167: bound active processes and memory, UI restrictions in the job).
pub const DEFAULT_ACTIVE_PROCESSES: u32 = 512;
pub const DEFAULT_MEMORY_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// Runs `program args` under `plan`'s container and job. Returns the command's exit code, or an
/// error that means it couldn't start (so the run fails closed). Windows only.
#[cfg(windows)]
pub fn exec(plan: &Plan, program: &std::ffi::OsStr, args: &[OsString]) -> Result<u32, String> {
    let limits = spade_sandbox_windows::job::Limits {
        active_processes: plan.active_processes,
        memory_bytes: usize::try_from(plan.memory_bytes).unwrap_or(usize::MAX),
    };
    let bridge = plan
        .bridge
        .as_ref()
        .map(|bridge| spade_sandbox_windows::launch::Bridge {
            pipe: bridge.pipe.clone(),
            port: bridge.port,
        });
    spade_sandbox_windows::launch::run(
        &plan.container.name,
        &plan.container.display,
        limits,
        bridge,
        program,
        args,
    )
    .map_err(|error| format!("the sandbox could not start the command: {error}"))
}

/// `spade sandbox-exec-win <plan> <program> <args>…`, from the launcher's `main`. Parses the plan,
/// runs the command and returns its exit code (126 when it can't start).
#[cfg(windows)]
pub fn launcher_main(args: &[OsString]) -> u8 {
    let (Some(plan), Some(program)) = (args.first(), args.get(1)) else {
        eprintln!("spade sandbox-exec-win: a plan and a program are needed");
        return 126;
    };
    let Some(plan) = plan
        .to_str()
        .and_then(|text| serde_json::from_str::<Plan>(text).ok())
    else {
        eprintln!("spade sandbox-exec-win: the plan doesn't parse");
        return 126;
    };
    match exec(&plan, program, &args[2..]) {
        Ok(code) => u8::try_from(code & 0xFF).unwrap_or(1),
        Err(why) => {
            eprintln!("spade sandbox-exec-win: {why}");
            126
        }
    }
}

/// The launcher invocation for `plan`: the program to run (Spade's own binary, `launcher`) and
/// its arguments, wrapping `program args`.
pub fn wrap(
    launcher: &std::path::Path,
    plan: &Plan,
    program: &std::path::Path,
    args: &[OsString],
) -> Result<(std::path::PathBuf, Vec<OsString>), String> {
    let plan = serde_json::to_string(plan).map_err(|error| format!("the sandbox plan: {error}"))?;
    let mut all: Vec<OsString> = vec![LAUNCHER_ARG.into(), plan.into()];
    all.push(program.as_os_str().to_owned());
    all.extend(args.iter().cloned());
    Ok((launcher.to_path_buf(), all))
}
