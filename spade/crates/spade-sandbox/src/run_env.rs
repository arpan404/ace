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

/// Why a variable can't be carried: a name with `=` would be read back as another name and
/// value, and one that is empty or not UTF-8 can't be named again exactly.
fn checked(name: &OsStr) -> Result<&str, String> {
    let text = name
        .to_str()
        .ok_or_else(|| format!("the variable {name:?} has a name that isn't UTF-8"))?;
    if text.is_empty() || text.contains('=') || text.contains('\0') {
        return Err(format!(
            "the variable {text:?} has a name that can't be carried"
        ));
    }
    Ok(text)
}

/// What Spade's own program is started with to carry `env`: the marker and each variable renamed.
/// A name that can't be carried exactly is refused, never dropped or changed.
pub fn sealed<K: AsRef<OsStr>, V: AsRef<OsStr>>(
    env: impl IntoIterator<Item = (K, V)>,
) -> Result<Vec<(OsString, OsString)>, String> {
    let mut out = vec![(OsString::from(MARKER), OsString::from("1"))];
    for (name, value) in env {
        let name = checked(name.as_ref())?;
        out.push((
            OsString::from(format!("{PREFIX}{name}")),
            value.as_ref().to_owned(),
        ));
    }
    Ok(out)
}

/// The environment carried in `vars` (this process's own), with the names restored; `None` when
/// it wasn't carried this way (a caller that passes the environment as it is). A carried name
/// that can't be restored exactly is an error: the command doesn't start.
pub fn opened(
    vars: impl IntoIterator<Item = (OsString, OsString)>,
) -> Result<Option<Vec<(OsString, OsString)>>, String> {
    let mut marked = false;
    let mut out = Vec::new();
    for (name, value) in vars {
        if name == MARKER {
            marked = true;
            continue;
        }
        if !name.as_encoded_bytes().starts_with(PREFIX.as_bytes()) {
            continue;
        }
        let name = checked(&name)?;
        let restored = &name[PREFIX.len()..];
        checked(OsStr::new(restored))?;
        out.push((OsString::from(restored), value));
    }
    Ok(marked.then_some(out))
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
        let carried = sealed(env).unwrap_or_default();
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
        let opened = opened(with_others).ok().flatten().unwrap_or_default();
        let expected: Vec<(OsString, OsString)> = env
            .iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value)))
            .collect();
        assert_eq!(opened, expected);
        // Without the marker, nothing was carried: the caller's environment stands.
        assert_eq!(
            super::opened([(OsString::from("PATH"), OsString::from("/bin"))]),
            Ok(None)
        );
    }

    #[test]
    fn a_name_that_cant_be_carried_exactly_is_refused_not_dropped() {
        // `A=B` would be read back as the variable `A` holding `B=…`.
        assert!(sealed([("A=B", "x")]).is_err());
        assert!(sealed([("", "x")]).is_err());
        // Carried in by hand, a name that can't be restored stops the command.
        for name in ["SPADE_RUN_ENV_", "SPADE_RUN_ENV_A=B"] {
            let vars = [
                (OsString::from(MARKER), OsString::from("1")),
                (OsString::from(name), OsString::from("x")),
            ];
            assert!(opened(vars).is_err(), "{name}");
        }
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            let mut raw = PREFIX.as_bytes().to_vec();
            raw.push(0xff);
            assert!(sealed([(OsString::from_vec(vec![0xff]), OsString::from("x"))]).is_err());
            let vars = [
                (OsString::from(MARKER), OsString::from("1")),
                (OsString::from_vec(raw), OsString::from("x")),
            ];
            assert!(opened(vars).is_err());
        }
    }
}
