//! The machine's Python environment (ADR 0220): one per lock Spade ships, built once and shared
//! by every bot. What a lock pins, what an environment is called, and whether what a build
//! installed is the lock and nothing else. Pure.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

/// The environment the machine's bots run with now, as Spade records it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Current {
    /// The environment's folder name.
    pub environment: String,
}

/// The name of the environment a lock (by `digest`) builds: with uv its packages, without uv
/// the standard library alone.
pub fn name(digest: &str, uv: bool) -> String {
    if uv {
        format!("locked-{}", &digest[..digest.len().min(16)])
    } else {
        "standard-library".to_owned()
    }
}

/// A package's name as PyPI compares names: lower case, runs of `-`, `_` and `.` as one `-`.
pub fn normal_name(name: &str) -> String {
    let mut out = String::new();
    let mut joined = false;
    for c in name.trim().chars() {
        if matches!(c, '-' | '_' | '.') {
            if !joined {
                out.push('-');
            }
            joined = true;
        } else {
            out.push(c.to_ascii_lowercase());
            joined = false;
        }
    }
    out
}

/// The versions a lock allows for each package (`name==version[ ; marker]` lines; a lock can
/// pin one name at two versions for two Pythons).
pub fn pins(lock: &str) -> BTreeMap<String, BTreeSet<String>> {
    let mut pins: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for line in lock.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.starts_with('-') {
            continue;
        }
        let Some((name, rest)) = line.split_once("==") else {
            continue;
        };
        let version: String = rest
            .chars()
            .take_while(|c| !c.is_whitespace() && *c != ';' && *c != '\\')
            .collect();
        pins.entry(normal_name(name)).or_default().insert(version);
    }
    pins
}

/// The name and version an installed package's `METADATA` says.
pub fn metadata(text: &str) -> Option<(String, String)> {
    let mut name = None;
    let mut version = None;
    for line in text.lines() {
        if line.is_empty() {
            break;
        }
        if let Some(value) = line.strip_prefix("Name:") {
            name = Some(normal_name(value));
        } else if let Some(value) = line.strip_prefix("Version:") {
            version = Some(value.trim().to_owned());
        }
    }
    Some((name?, version?))
}

/// Whether a built environment is the lock: every installed package locked at its installed
/// version, every one of `wanted` installed, and no `.pth` start-up file among `files` (the
/// top-level names in its installed packages' folder). Answers what is wrong.
pub fn check(
    lock: &BTreeMap<String, BTreeSet<String>>,
    installed: &BTreeMap<String, String>,
    wanted: &[&str],
    files: &[String],
) -> Result<(), String> {
    for (name, version) in installed {
        match lock.get(name) {
            Some(versions) if versions.contains(version) => {}
            Some(_) => {
                return Err(format!(
                    "{name} {version} is installed, not a locked version"
                ));
            }
            None => return Err(format!("{name} is installed but not in the lock")),
        }
    }
    if let Some(missing) = wanted
        .iter()
        .find(|name| !installed.contains_key(&normal_name(name)))
    {
        return Err(format!("{missing} is in the lock but wasn't installed"));
    }
    if let Some(hook) = files.iter().find(|file| file.ends_with(".pth")) {
        return Err(format!(
            "a locked package installs {hook}, a start-up hook Spade doesn't run"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn installed(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(n, v)| ((*n).to_owned(), (*v).to_owned()))
            .collect()
    }

    const LOCK: &str = "# a comment\n\
        numpy==2.4.6 \\\n    --hash=sha256:aa\n\
        contourpy==1.3.3 ; python_full_version < '3.12' \\\n    --hash=sha256:bb\n\
        contourpy==1.4.0 ; python_full_version >= '3.12' \\\n    --hash=sha256:cc\n\
        Python_Docx==1.2.0\n";

    #[test]
    fn a_lock_pins_each_name_at_the_versions_it_lists() {
        let pins = pins(LOCK);
        assert_eq!(pins["numpy"], BTreeSet::from(["2.4.6".to_owned()]));
        assert_eq!(
            pins["contourpy"],
            BTreeSet::from(["1.3.3".to_owned(), "1.4.0".to_owned()])
        );
        assert!(pins.contains_key("python-docx"));
        assert_eq!(pins.len(), 3);
    }

    #[test]
    fn a_built_environment_counts_only_when_it_is_the_lock_and_runs_nothing_at_start() {
        let lock = pins(LOCK);
        let good = installed(&[
            ("numpy", "2.4.6"),
            ("contourpy", "1.4.0"),
            ("python-docx", "1.2.0"),
        ]);
        let files = vec!["numpy".to_owned(), "numpy-2.4.6.dist-info".to_owned()];
        assert_eq!(
            check(&lock, &good, &["numpy", "python_docx"], &files),
            Ok(())
        );
        let other = installed(&[("numpy", "2.5.0")]);
        assert!(check(&lock, &other, &[], &files).is_err());
        let extra = installed(&[("numpy", "2.4.6"), ("evil", "1.0")]);
        assert!(check(&lock, &extra, &[], &files).is_err());
        assert!(check(&lock, &installed(&[]), &["numpy"], &files).is_err());
        let hooked = vec!["distutils-precedence.pth".to_owned()];
        let refused = check(&lock, &good, &[], &hooked).err().unwrap_or_default();
        assert!(refused.contains("distutils-precedence.pth"), "{refused}");
        assert_eq!(
            metadata("Metadata-Version: 2.1\nName: Spade_Check\nVersion: 1.0\n\nName: body"),
            Some(("spade-check".to_owned(), "1.0".to_owned()))
        );
    }

    #[test]
    fn an_environment_is_named_by_its_lock_or_as_the_standard_library() {
        assert_eq!(
            name("0123456789abcdef0123", true),
            "locked-0123456789abcdef"
        );
        assert_eq!(name("0123", false), "standard-library");
    }
}
