//! How a bot's worker is started (ADR 0203 §3): inside the bot's OS sandbox (ADR 0167), held
//! offline (no socket, no connect, no listen) with no folder but its own, which holds its
//! components, and with nothing of the person's environment. `spade-wasm` is its own sandbox
//! launcher, as Spade's binary is, so the run starts sealed. A machine whose sandbox can't hold it
//! offline doesn't run code: the first wall is never the only one.

use std::path::{Path, PathBuf};

use spade_sandbox::{Facts, Policy, Runner};
use tokio::process::Command;

/// Where the worker starts from and what it may touch.
#[derive(Debug, Clone)]
pub struct Place {
    /// The `spade-wasm` binary.
    pub program: PathBuf,
    /// The worker's own folder: its components, nothing else. Made if missing.
    pub folder: PathBuf,
    /// The person's home folder, hidden from the run.
    pub home: PathBuf,
    /// Spade's data folder, denied to the run but for `folder` inside it.
    pub spade_data: PathBuf,
    /// ace's data folder, denied, when known.
    pub ace_data: Option<PathBuf>,
}

/// The command that starts the worker for `place` under `runner`'s sandbox, offline.
pub fn command(runner: &Runner, place: &Place) -> Result<Command, String> {
    std::fs::create_dir_all(place.folder.join(spade_sandbox::policy::TEMP))
        .map_err(|e| format!("the code folder couldn't be made: {e}"))?;
    // The program's own folder is read so it can start; nothing else outside the system's.
    let program_dir = place
        .program
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let policy = Policy::build(&Facts {
        home: place.home.clone(),
        spade_data: place.spade_data.clone(),
        ace_data: place.ace_data.clone(),
        workspace: place.folder.clone(),
        folders: Vec::new(),
        toolchains: vec![program_dir],
        also_read: Vec::new(),
        scratch: Vec::new(),
        proxy_port: None,
    });
    let launch = runner
        .wrap_offline(&policy, &place.program, &[])
        .map_err(|why| format!("code runs only inside the bot's sandbox, and {why}"))?;
    let mut command = Command::new(&launch.program);
    command
        .args(&launch.args)
        .current_dir(&policy.workspace)
        .env_clear();
    let env = [
        ("PATH", "/usr/bin:/bin"),
        ("HOME", policy.workspace.to_str().unwrap_or("/")),
        ("TMPDIR", policy.temp.to_str().unwrap_or("/tmp")),
    ];
    if launch.seals_env {
        command.envs(spade_sandbox::run_env::sealed(env)?);
    } else {
        command.envs(env);
    }
    Ok(command)
}
