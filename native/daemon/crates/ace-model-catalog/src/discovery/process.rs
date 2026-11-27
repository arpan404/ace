// SPDX-License-Identifier: Apache-2.0
//! The process port: a provider CLI run to completion, bounded by the caller's signal.
//!
//! The runner owns supervision (timeouts, output bounds, reaping); this crate only says
//! what to run and reads the reply's bytes through `ace-models`.

use ace_models::instance::ModelInstance;

use crate::failures::DiscoveryFailure;

/// One CLI invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessCommand {
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: Vec<(String, String)>,
    /// Variables the child must not inherit from the daemon.
    pub unset_env: Vec<String>,
    /// Text written to the child's stdin, when the protocol needs it.
    pub stdin: Option<String>,
}

impl ProcessCommand {
    /// The command an instance's discovery launches, with `args` appended.
    pub fn for_instance(instance: &ModelInstance, args: Vec<String>) -> Self {
        Self {
            executable: instance.executable.clone(),
            args: instance.args.iter().cloned().chain(args).collect(),
            cwd: instance.cwd.clone(),
            env: instance.env.clone(),
            unset_env: instance.unset_env.clone(),
            stdin: None,
        }
    }
}

/// What a finished process left behind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessOutput {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// The runner a discovery port is given.
pub trait ProcessRunner: Send + Sync {
    #[allow(clippy::result_large_err)]
    fn run(
        &self,
        command: &ProcessCommand,
        aborted: &dyn Fn() -> bool,
    ) -> Result<ProcessOutput, DiscoveryFailure>;
}

/// A finished run, or the fixed failure a non-zero exit stands for.
///
/// The child's prose never leaves this module: a runner that cannot classify reports an
/// empty message, which the catalog then shows as `discovery_failed`.
#[allow(clippy::result_large_err)]
pub fn completed(output: ProcessOutput) -> Result<String, DiscoveryFailure> {
    if output.status == Some(0) {
        return Ok(output.stdout);
    }
    Err(DiscoveryFailure {
        message: Some(output.stderr.chars().take(8192).collect()),
        ..DiscoveryFailure::default()
    })
}
