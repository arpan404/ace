// SPDX-License-Identifier: Apache-2.0
//! Ownership markers: which spawns carry a run id and which processes do.
//! Ports `process-marker.ts`: the run id a daemon run's spawns carry, the
//! exact-match sweep over environments, and the kept-process record.

use crate::errors::SupervisorError;

/// The environment variable a supervised spawn carries, naming its daemon run.
pub const PROCESS_OWNER_ENV: &str = "ACE_PROCESS_OWNER";
/// The variable marking a process ace started to outlive it; proves nothing.
pub const PROCESS_KEEP_ENV: &str = "ACE_PROCESS_KEEP";

/// A run id: what a claim accepts, so a marker can't be empty or a prefix.
pub fn valid_run_id(id: &str) -> bool {
    if !(16..=64).contains(&id.len()) {
        return false;
    }
    id.bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

/// The environment a marked spawn sees: `env` plus the run's marker.
pub fn marked_env(
    env: &[(String, String)],
    run: Option<&str>,
) -> Result<Vec<(String, String)>, SupervisorError> {
    let Some(run) = run else {
        return Ok(env.to_vec());
    };
    if !valid_run_id(run) {
        return Err(SupervisorError::InvalidInput(
            "invalid process owner id".to_owned(),
        ));
    }
    let mut marked = env.to_vec();
    marked.retain(|(name, _)| name != PROCESS_OWNER_ENV);
    marked.push((PROCESS_OWNER_ENV.to_owned(), run.to_owned()));
    Ok(marked)
}

/// `env` for a process ace starts to outlive it: kept, never marked.
pub fn kept_env(env: &[(String, String)]) -> Vec<(String, String)> {
    let mut kept = env.to_vec();
    kept.retain(|(name, _)| name != PROCESS_OWNER_ENV);
    kept.push((PROCESS_KEEP_ENV.to_owned(), "1".to_owned()));
    kept
}

/// Whether a start environment carries exactly `id`'s marker.
pub fn carries_owner(environment: &[String], id: &str) -> bool {
    if !valid_run_id(id) {
        return false;
    }
    let entry = format!("{PROCESS_OWNER_ENV}={id}");
    environment.iter().any(|line| line == &entry)
}

/// One kernel read of a process, enough for the marker sweep.
pub trait MarkedListing {
    /// Every process this user can see.
    fn all(&self) -> Vec<u32>;
    /// One kernel read of a process: start and zombie state.
    fn info(&self, pid: u32) -> Option<MarkedInfo>;
    /// Its start environment, or `None` when hidden or gone.
    fn environment(&self, pid: u32) -> Option<Vec<String>>;
}

/// What the sweep reads per process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkedInfo {
    /// The same string `identity` gives for this process.
    pub start: String,
    /// Zombies are left out.
    pub zombie: bool,
}

/// A swept process: its pid and kernel start, so a reused pid never matches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkedProcess {
    pub pid: u32,
    pub start: String,
}

/// Every process whose start environment carries `id`'s marker. Each is read
/// as identity, environment, identity: the environment counts only when both
/// identity reads give the same start. Zombies are left out.
pub fn marked_processes<L: MarkedListing>(id: &str, listing: &L) -> Vec<MarkedProcess> {
    if !valid_run_id(id) {
        return Vec::new();
    }
    let mut found = Vec::new();
    for pid in listing.all() {
        let Some(before) = listing.info(pid) else {
            continue;
        };
        if before.zombie {
            continue;
        }
        let environment = listing.environment(pid);
        let Some(environment) = environment else {
            continue;
        };
        if !carries_owner(&environment, id) {
            continue;
        }
        let Some(after) = listing.info(pid) else {
            continue;
        };
        if !after.zombie && after.start == before.start {
            found.push(MarkedProcess {
                pid,
                start: before.start,
            });
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const RUN: &str = "0b9e2c4c-7f3a-4c1e-9a55-2f1d8e6b7a10";
    const OTHER: &str = "5d1f0a7e-2b3c-4d5e-8f90-a1b2c3d4e5f6";

    struct Fake {
        table: HashMap<u32, (String, Vec<String>)>,
    }

    impl MarkedListing for Fake {
        fn all(&self) -> Vec<u32> {
            self.table.keys().copied().collect()
        }

        fn info(&self, pid: u32) -> Option<MarkedInfo> {
            self.table.get(&pid).map(|(start, _)| MarkedInfo {
                start: start.clone(),
                zombie: false,
            })
        }

        fn environment(&self, pid: u32) -> Option<Vec<String>> {
            self.table.get(&pid).map(|(_, env)| env.clone())
        }
    }

    fn machine(rows: &[(u32, &str, &[&str])]) -> Fake {
        Fake {
            table: rows
                .iter()
                .map(|(pid, start, env)| {
                    (
                        *pid,
                        (
                            (*start).to_owned(),
                            env.iter().map(|line| (*line).to_owned()).collect(),
                        ),
                    )
                })
                .collect(),
        }
    }

    #[test]
    fn run_id_accepts_only_dense_ids() {
        assert!(valid_run_id(RUN));
        assert!(!valid_run_id(""));
        assert!(!valid_run_id("short"));
        assert!(!valid_run_id("has spaces in ittttt"));
        assert!(!valid_run_id("with_underscore_in_it"));
    }

    #[test]
    fn marked_env_adds_the_claim_and_drops_an_inherited_marker() {
        let env = vec![
            ("PATH".to_owned(), "/bin".to_owned()),
            ("ACE_PROCESS_OWNER".to_owned(), OTHER.to_owned()),
        ];
        assert_eq!(
            marked_env(&env, Some(RUN)),
            Ok(vec![
                ("PATH".to_owned(), "/bin".to_owned()),
                ("ACE_PROCESS_OWNER".to_owned(), RUN.to_owned()),
            ])
        );
        assert_eq!(marked_env(&env, None), Ok(env.clone()));
        assert!(marked_env(&env, Some("bad")).is_err());
    }

    #[test]
    fn kept_env_marks_kept_and_drops_any_owner() {
        let env = vec![
            ("PATH".to_owned(), "/bin".to_owned()),
            ("ACE_PROCESS_OWNER".to_owned(), RUN.to_owned()),
        ];
        assert_eq!(
            kept_env(&env),
            vec![
                ("PATH".to_owned(), "/bin".to_owned()),
                ("ACE_PROCESS_KEEP".to_owned(), "1".to_owned()),
            ]
        );
    }

    #[test]
    fn marker_matches_its_own_run_exactly() {
        let environment = vec![
            format!("{PROCESS_OWNER_ENV}={RUN}"),
            "HOME=/home/a".to_owned(),
        ];
        assert!(carries_owner(&environment, RUN));
        assert!(!carries_owner(&environment, OTHER));
        assert!(!carries_owner(&environment, &RUN[..20]));
        assert!(!carries_owner(&[format!("{PROCESS_OWNER_ENV}=")], ""));
        assert!(!carries_owner(&environment, &format!("{RUN}-extra")));
    }

    #[test]
    fn sweep_finds_this_runs_orphans_not_another_home_or_hidden_ones() {
        let listing = machine(&[
            (300, "orphan", &[&format!("{PROCESS_OWNER_ENV}={RUN}")]),
            (
                400,
                "other-home",
                &[&format!("{PROCESS_OWNER_ENV}={OTHER}")],
            ),
            (500, "hidden", &[]),
        ]);
        assert_eq!(
            marked_processes(RUN, &listing),
            vec![MarkedProcess {
                pid: 300,
                start: "orphan".to_owned(),
            }]
        );
        assert!(marked_processes("bad", &listing).is_empty());
    }
}
