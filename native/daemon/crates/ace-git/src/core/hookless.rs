// SPDX-License-Identifier: Apache-2.0
//! Windows-only command and environment rewriting (G2a): a private empty
//! `core.hooksPath` instead of `/dev/null`, and long checkout paths.

use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};

/// The injected private hooks directory factory; Windows only, where `/dev/null` is not a path.
pub fn default_hooks_dir() -> Option<Arc<dyn Fn() -> String + Send + Sync>> {
    #[cfg(windows)]
    {
        Some(Arc::new(|| windows_private_hooks_dir().to_owned()))
    }
    #[cfg(not(windows))]
    {
        None
    }
}

fn windows_private_hooks_dir() -> &'static str {
    static DIR: OnceLock<String> = OnceLock::new();
    DIR.get_or_init(|| {
        let base = std::env::temp_dir();
        let pid = std::process::id();
        for attempt in 0u32..1000 {
            let candidate = base.join(format!("ace-git-hooks-{pid}-{attempt}"));
            if std::fs::create_dir(&candidate).is_ok() {
                return candidate.to_string_lossy().into_owned();
            }
        }
        base.join(format!("ace-git-hooks-{pid}"))
            .to_string_lossy()
            .into_owned()
    })
}

/// Windows only: rewrite `-c core.hooksPath=/dev/null` to a private empty directory.
pub fn windows_hookless_args(args: &[String], hooks_dir: Option<&str>) -> Vec<String> {
    args.iter()
        .enumerate()
        .map(|(index, arg)| {
            if index > 0 && args[index - 1] == "-c" && arg == "core.hooksPath=/dev/null" {
                format!(
                    "core.hooksPath={}",
                    hooks_dir.unwrap_or_else(|| windows_private_hooks_dir())
                )
            } else {
                arg.clone()
            }
        })
        .collect()
}

/// Windows only: rewrite `GIT_CONFIG_KEY_i=core.hooksPath` with `/dev/null` value.
pub fn windows_hookless_env(env: &mut BTreeMap<String, String>, hooks_dir: Option<&str>) {
    let count = env
        .get("GIT_CONFIG_COUNT")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    for idx in 0..count {
        let key_name = format!("GIT_CONFIG_KEY_{idx}");
        let val_name = format!("GIT_CONFIG_VALUE_{idx}");
        if env.get(&key_name).map(String::as_str) == Some("core.hooksPath")
            && env.get(&val_name).map(String::as_str) == Some("/dev/null")
        {
            env.insert(
                val_name,
                hooks_dir
                    .map(str::to_owned)
                    .unwrap_or_else(|| windows_private_hooks_dir().to_owned()),
            );
        }
    }
}

/// Windows only: append `core.longpaths=true` to `GIT_CONFIG_*` entries.
pub fn windows_long_paths_env(env: &mut BTreeMap<String, String>) {
    let count = match env.get("GIT_CONFIG_COUNT") {
        None => 0usize,
        Some(raw) => match raw.parse::<usize>() {
            Ok(n) => n,
            Err(_) => return,
        },
    };
    env.insert(
        format!("GIT_CONFIG_KEY_{count}"),
        "core.longpaths".to_owned(),
    );
    env.insert(format!("GIT_CONFIG_VALUE_{count}"), "true".to_owned());
    env.insert("GIT_CONFIG_COUNT".to_owned(), (count + 1).to_string());
}
