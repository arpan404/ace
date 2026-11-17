//! Running a bot's plugin hooks (ADR 0151, point 12): each the plugin's command, in the bot's
//! workspace with the shell's built environment, the event as JSON on stdin, and 10 seconds.
//! What an answer means is `spade_core::hooks`.

use std::time::Duration;

use serde_json::Value;
use spade_core::hooks::{self, HookOutcome, HookResult};

use super::{Plugins, root_vars, view};
use crate::workspace::shell::Job;

/// How long one hook may run.
pub const LIMIT: Duration = Duration::from_secs(10);

impl Plugins {
    /// Whether `agent` has any hook at `event`. ace's plugins are read again first when the last
    /// reading is stale, so a plugin turned off in ace stops running its hooks.
    pub async fn has_hooks(&self, agent: &str, event: &str) -> bool {
        self.refresh_briefly().await;
        self.for_agent(agent).iter().any(|plugin| {
            view::usable(plugin, false)
                .hooks
                .iter()
                .any(|hook| hook.event == event)
        })
    }

    /// Runs `agent`'s hooks at `event` whose matcher covers `tool` (every hook when `tool` is
    /// `None`), one after another in plugin order, each with `input` (plus `hook_event_name` and
    /// `cwd`) on stdin. Answers each hook's outcome; none when it has no hooks there.
    pub async fn run_hooks(
        &self,
        agent: &str,
        event: &str,
        tool: Option<&str>,
        mut input: Value,
    ) -> Vec<HookOutcome> {
        self.refresh_briefly().await;
        let mut todo = Vec::new();
        for plugin in self.for_agent(agent) {
            for hook in view::usable(&plugin, false).hooks {
                if hook.event == event
                    && tool.is_none_or(|tool| hooks::matches(hook.matcher.as_deref(), tool))
                {
                    todo.push((plugin.root.clone(), hook));
                }
            }
        }
        if todo.is_empty() {
            return Vec::new();
        }
        let Some(dir) = self.workspace_dir(agent) else {
            return todo
                .into_iter()
                .map(|(_, hook)| HookOutcome {
                    plugin: hook.plugin,
                    command: hook.command,
                    result: HookResult::Failed {
                        why: "the bot's workspace could not be opened".to_owned(),
                    },
                })
                .collect();
        };
        if let Value::Object(fields) = &mut input {
            fields.insert("hook_event_name".into(), event.into());
            fields.insert("cwd".into(), dir.to_string_lossy().into_owned().into());
        }
        let stdin = input.to_string().into_bytes();
        let mut outcomes = Vec::new();
        for (root, hook) in todo {
            // A command names its folder as `${PLUGIN_ROOT}`; `sh` reads it from the variable,
            // which keeps the author's quoting. cmd.exe can't, so there it is written out.
            let script = if cfg!(windows) {
                super::expand_root(&hook.command, &root)
            } else {
                hook.command.clone()
            };
            let ran = self
                .shell
                .run_job(Job {
                    dir: &dir,
                    script: &script,
                    timeout: self.hook_limit(),
                    env: &root_vars(&root),
                    tee: None,
                    cleanup: None,
                    stdin: Some(stdin.clone()),
                    kind: crate::workspace::shell::Kind::Plugin {
                        root: std::path::PathBuf::from(&root),
                    },
                    outside: false,
                    // A plugin hook isn't reviewed; if it can't be contained it is refused, never
                    // run unconfined.
                    may_run_uncontained: false,
                })
                .await;
            let result = match ran {
                Ok(ran) => hooks::decide(ran.code, ran.timed_out, &ran.stdout, &ran.stderr),
                Err(why) => HookResult::Failed { why },
            };
            if let HookResult::Failed { why } = &result {
                tracing::warn!(plugin = %hook.plugin, event, %why, "a plugin's hook failed");
            }
            outcomes.push(HookOutcome {
                plugin: hook.plugin,
                command: hook.command,
                result,
            });
        }
        outcomes
    }
}
