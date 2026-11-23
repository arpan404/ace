//! A bot's Python environment as generations (ADR 0220): each change builds a new one from the
//! whole wanted set, Spade checks what got installed against what was resolved and asked for,
//! and only then makes it the current one. A run is given the generation current when it starts,
//! and nothing changes a generation once it is made. Pure.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The current generation, as Spade records it in `control/generation.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Generation {
    pub id: String,
    /// The digest of the set-up it was built by (its script and its locked packages).
    pub setup: String,
    /// Built with uv (packages), or without (the standard library only).
    pub uv: bool,
    /// The packages calls asked for, as they asked, in it.
    pub asked: Vec<String>,
    /// What is installed in it, by normalised name.
    pub installed: BTreeMap<String, String>,
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

/// A checked spec's name and version, if it pins one.
fn split(spec: &str) -> (String, Option<&str>) {
    match spec.split_once("==") {
        Some((name, version)) => (normal_name(name), Some(version)),
        None => (normal_name(spec), None),
    }
}

/// Whether `installed` holds what `spec` asks for.
pub fn satisfied(spec: &str, installed: &BTreeMap<String, String>) -> bool {
    let (name, version) = split(spec);
    installed
        .get(&name)
        .is_some_and(|have| version.is_none_or(|want| want == have))
}

/// What a new generation installs: the locked packages, then what calls asked for before and
/// now, a later ask for a name replacing an earlier one. `None` when `current` (built by this
/// set-up, with uv as now) already holds everything asked now.
pub fn wanted(
    current: Option<&Generation>,
    setup: &str,
    uv: bool,
    locked: &[String],
    asked: &[String],
) -> Option<Vec<String>> {
    let fits = current.filter(|g| g.setup == setup && g.uv == uv);
    if let Some(generation) = fits
        && asked
            .iter()
            .all(|spec| satisfied(spec, &generation.installed))
    {
        return None;
    }
    let mut extra: Vec<String> = fits.map(|g| g.asked.clone()).unwrap_or_default();
    for spec in asked {
        let (name, _) = split(spec);
        extra.retain(|earlier| split(earlier).0 != name);
        extra.push(spec.clone());
    }
    Some(if uv {
        locked.iter().cloned().chain(extra).collect()
    } else {
        Vec::new()
    })
}

/// The packages a resolution pinned (`name==version` lines of `resolved.txt`).
pub fn pins(resolved: &str) -> Vec<(String, String)> {
    resolved
        .lines()
        .filter_map(|line| {
            let line = line.trim().trim_end_matches('\\').trim();
            let (name, version) = line.split_once("==")?;
            (!name.starts_with('-')).then(|| (normal_name(name), version.trim().to_owned()))
        })
        .collect()
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

/// What a generation holds, checked: every pinned package installed at its pinned version, and
/// every asked package there. Answers the installed packages, or what is wrong.
pub fn verify(
    pinned: &[(String, String)],
    installed: &BTreeMap<String, String>,
    asked: &[String],
) -> Result<BTreeMap<String, String>, String> {
    for (name, version) in pinned {
        match installed.get(name) {
            Some(have) if have == version => {}
            Some(have) => {
                return Err(format!(
                    "{name} was resolved at {version} but {have} is installed"
                ));
            }
            None => return Err(format!("{name} {version} was resolved but isn't installed")),
        }
    }
    if let Some(missing) = asked.iter().find(|spec| !satisfied(spec, installed)) {
        return Err(format!("{missing} was asked for but isn't installed"));
    }
    Ok(installed.clone())
}

/// The generations to delete once `current` is made current: all but it and the newest
/// `keep - 1` others, oldest first by `made` order (ids in the order they were made).
pub fn stale(made: &[String], current: &str, keep: usize) -> Vec<String> {
    let others: Vec<&String> = made.iter().filter(|id| *id != current).collect();
    let drop = others.len().saturating_sub(keep.saturating_sub(1));
    others.into_iter().take(drop).cloned().collect()
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

    fn generation(asked: &[&str], have: &[(&str, &str)]) -> Generation {
        Generation {
            id: "g1".to_owned(),
            setup: "s".to_owned(),
            uv: true,
            asked: asked.iter().map(|s| (*s).to_owned()).collect(),
            installed: installed(have),
        }
    }

    #[test]
    fn names_compare_as_pypi_compares_them() {
        assert_eq!(normal_name("Python_Docx"), "python-docx");
        assert_eq!(normal_name("zope..interface"), "zope-interface");
    }

    #[test]
    fn a_new_generation_holds_the_locked_set_and_every_ask_and_none_is_built_when_nothing_is_new() {
        let locked = vec!["numpy==2.4.6".to_owned()];
        let current = generation(&["extra==1.0"], &[("numpy", "2.4.6"), ("extra", "1.0")]);
        assert_eq!(
            wanted(
                Some(&current),
                "s",
                true,
                &locked,
                &["Extra==1.0".to_owned()]
            ),
            None
        );
        assert_eq!(
            wanted(
                Some(&current),
                "s",
                true,
                &locked,
                &["extra==2.0".to_owned()]
            ),
            Some(vec!["numpy==2.4.6".to_owned(), "extra==2.0".to_owned()])
        );
        // An ask for a version that isn't the one installed (an old record) builds again.
        let stale_record = generation(&["extra==1.0"], &[("numpy", "2.4.6"), ("extra", "0.9")]);
        assert!(
            wanted(
                Some(&stale_record),
                "s",
                true,
                &locked,
                &["extra==1.0".to_owned()]
            )
            .is_some()
        );
        // Another set-up, or uv gone: built again, without uv from nothing.
        assert_eq!(
            wanted(Some(&current), "other", true, &locked, &[]),
            Some(locked.clone())
        );
        assert_eq!(
            wanted(Some(&current), "s", false, &locked, &[]),
            Some(Vec::new())
        );
        assert_eq!(wanted(None, "s", true, &locked, &[]), Some(locked));
    }

    #[test]
    fn a_generation_is_made_current_only_when_it_holds_what_was_resolved_and_asked() {
        let resolved = format!(
            "numpy==2.4.6 \\\n    --hash=sha256:{}\nspade_check==1.0\n",
            "a".repeat(64)
        );
        let pinned = pins(&resolved);
        assert_eq!(
            pinned,
            vec![
                ("numpy".to_owned(), "2.4.6".to_owned()),
                ("spade-check".to_owned(), "1.0".to_owned())
            ]
        );
        let good = installed(&[("numpy", "2.4.6"), ("spade-check", "1.0")]);
        assert!(verify(&pinned, &good, &["spade_check==1.0".to_owned()]).is_ok());
        let upgraded = installed(&[("numpy", "2.5.0"), ("spade-check", "1.0")]);
        assert!(verify(&pinned, &upgraded, &[]).is_err());
        assert!(verify(&pinned, &good, &["other".to_owned()]).is_err());
        assert_eq!(
            metadata("Metadata-Version: 2.1\nName: Spade_Check\nVersion: 1.0\n\nName: body"),
            Some(("spade-check".to_owned(), "1.0".to_owned()))
        );
    }

    #[test]
    fn only_the_current_generation_and_the_ones_before_it_are_kept() {
        let made: Vec<String> = ["a", "b", "c", "d"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        assert_eq!(stale(&made, "d", 3), vec!["a".to_owned()]);
        assert_eq!(
            stale(&made, "d", 1),
            vec!["a".to_owned(), "b".to_owned(), "c".to_owned()]
        );
        assert!(stale(&made[..2], "b", 3).is_empty());
    }
}
