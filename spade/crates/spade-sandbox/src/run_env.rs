//! The environment a run is started with, carried past Spade's own program (ADR 0171,
//! amendment 4). The launcher (Linux) and the trampoline in front of `sandbox-exec` (macOS) are
//! Spade's binary, started outside the sandbox. A run's environment comes partly from a plugin's
//! entry, and the system's loader acts on some names before any code of Spade's runs
//! (`LD_PRELOAD` and the rest of `LD_*`, `DYLD_*`). So such a program is started with the run's
//! variables renamed (`SPADE_RUN_ENV_<name>`) under a marker, which no loader reads, and it
//! restores them, and only them, on the command it starts inside the sandbox. Pure.

use std::ffi::{OsStr, OsString};

/// Present when the environment is carried this way.
pub const MARKER: &str = "SPADE_RUN_ENV";
/// Each carried variable's name starts with this.
pub const PREFIX: &str = "SPADE_RUN_ENV_";

/// What Spade's own program is started with to carry `env`: the marker and each variable renamed.
pub fn sealed<K: AsRef<OsStr>, V: AsRef<OsStr>>(
    env: impl IntoIterator<Item = (K, V)>,
) -> Vec<(OsString, OsString)> {
    let mut out = vec![(OsString::from(MARKER), OsString::from("1"))];
    out.extend(env.into_iter().map(|(name, value)| {
        let mut carried = OsString::from(PREFIX);
        carried.push(name.as_ref());
        (carried, value.as_ref().to_owned())
    }));
    out
}

/// The environment carried in `vars` (this process's own), with the names restored; `None` when
/// it wasn't carried this way (a caller that passes the environment as it is).
pub fn opened(
    vars: impl IntoIterator<Item = (OsString, OsString)>,
) -> Option<Vec<(OsString, OsString)>> {
    let mut marked = false;
    let mut out = Vec::new();
    for (name, value) in vars {
        if name == MARKER {
            marked = true;
            continue;
        }
        let Some(name) = name.to_str().and_then(|name| name.strip_prefix(PREFIX)) else {
            continue;
        };
        if !name.is_empty() {
            out.push((OsString::from(name), value));
        }
    }
    marked.then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_carried_environment_reaches_the_command_and_nothing_the_loader_reads_reaches_spade() {
        let env = [
            ("PATH", "/usr/bin:/bin"),
            ("API_TOKEN", "t0k"),
            ("LD_PRELOAD", "/tmp/evil.so"),
            ("DYLD_INSERT_LIBRARIES", "/tmp/evil.dylib"),
        ];
        let carried = sealed(env);
        // What Spade's own program starts with: no name a loader acts on.
        for (name, _) in &carried {
            let name = name.to_string_lossy();
            assert!(
                !name.starts_with("LD_") && !name.starts_with("DYLD_"),
                "{name}"
            );
            assert!(name == MARKER || name.starts_with(PREFIX), "{name}");
        }
        // What the command inside gets: the run's environment, as it was, and nothing else.
        let mut with_others = carried.clone();
        with_others.push(("HOME".into(), "/somewhere".into()));
        let opened = opened(with_others).unwrap_or_default();
        let expected: Vec<(OsString, OsString)> = env
            .iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value)))
            .collect();
        assert_eq!(opened, expected);
        // Without the marker, nothing was carried: the caller's environment stands.
        assert_eq!(
            super::opened([(OsString::from("PATH"), OsString::from("/bin"))]),
            None
        );
    }
}
