// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::collections::HashMap;

struct Fake {
    files: HashMap<String, Vec<u8>>,
    dirs: HashMap<String, Vec<String>>,
    table_reads: std::cell::Cell<usize>,
}

impl ProcFs for Fake {
    fn list(&self, path: &str) -> Option<Vec<String>> {
        if path == "/proc" {
            self.table_reads.set(self.table_reads.get() + 1);
        }
        if let Some(dirs) = self.dirs.get(path) {
            return Some(dirs.clone());
        }
        // A task directory exists for every known pid, but no kernel
        // in this test keeps per-task child lists.
        let task = path.strip_prefix("/proc/")?.strip_suffix("/task")?;
        if task.parse::<u32>().is_ok() && self.files.contains_key(&format!("/proc/{task}/stat")) {
            return Some(vec![task.to_owned()]);
        }
        None
    }

    fn read(&self, path: &str, _limit: usize) -> Option<Vec<u8>> {
        self.files.get(path).cloned()
    }
}

/// A /proc stat line for `pid` under `parent`, starting at tick `<pid>0`.
fn fake_stat(pid: u32, parent: u32) -> String {
    format!(
        "{pid} (p) S {parent} {pid} {} {pid}0 0",
        ["0"].repeat(17).join(" ")
    )
}

/// A /proc with `parents` (pid to parent) and no per-task child lists.
fn machine(parents: &[(u32, u32)]) -> LinuxListing<Fake> {
    let mut files = HashMap::new();
    files.insert(
        "/proc/sys/kernel/random/boot_id".to_owned(),
        b"0b9e2c4c-7f3a-4c1e-9a55-2f1d8e6b7a10\n".to_vec(),
    );
    let mut names = Vec::new();
    for (pid, parent) in parents {
        files.insert(
            format!("/proc/{pid}/stat"),
            fake_stat(*pid, *parent).into_bytes(),
        );
        names.push(pid.to_string());
    }
    LinuxListing::new(Fake {
        files,
        dirs: [("/proc".to_owned(), names)].into_iter().collect(),
        table_reads: std::cell::Cell::new(0),
    })
}

/// Counts how often the walk read the process table.
fn table_reads(walk: &LinuxWalk<Fake>) -> usize {
    walk.listing().procfs.table_reads.get()
}

#[test]
fn child_lists_hold_space_separated_pids() {
    assert_eq!(parse_child_list("12 13  x 14\n"), vec![12, 13, 14]);
}

#[test]
fn nul_lists_split_and_drop_empties() {
    assert_eq!(parse_nul_list(b"A=1\0B=2\0\0"), vec!["A=1", "B=2"]);
}

#[test]
fn proc_args2_splits_argv_from_environment() {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&2i32.to_le_bytes());
    bytes.extend_from_slice(
        b"/usr/local/bin/codex\0\0\0\0codex\0app-server\0A=1\0ACE_PROCESS_OWNER=x\0\0junk",
    );
    assert_eq!(
        parse_proc_args2(&bytes),
        (
            vec!["codex".to_owned(), "app-server".to_owned()],
            vec!["A=1".to_owned(), "ACE_PROCESS_OWNER=x".to_owned()],
        )
    );
    // A platform binary: arguments, no environment.
    let mut short = Vec::new();
    short.extend_from_slice(&2i32.to_le_bytes());
    short.extend_from_slice(b"/bin/sleep\0/bin/sleep\x0030\0");
    assert!(parse_proc_args2(&short).1.is_empty());
    assert_eq!(parse_proc_args2(&[0, 0]), (Vec::new(), Vec::new()));
}

#[test]
fn linux_stat_parses_state_parent_group_and_ticks() {
    let fields: Vec<String> = (0..19).map(|index| index.to_string()).collect();
    let text = format!("42 (a (weird) name) Z 7 42 {} 99 1", fields.join(" "));
    assert_eq!(
        parse_linux_stat(&text),
        Ok(LinuxStat {
            state: 'Z',
            ppid: 7,
            group: 42,
            ticks: "16".to_owned(),
        })
    );
    assert!(parse_linux_stat("42 (short) S 1").is_err());
}

#[test]
fn cgroup_paths_keep_only_unified_hierarchy_entries() {
    assert_eq!(
        parse_cgroup_path("0::/user.slice/user@1000.service/app.slice/ace-next.service\n"),
        Some("/user.slice/user@1000.service/app.slice/ace-next.service".to_owned())
    );
    assert_eq!(parse_cgroup_path("12:pids:/legacy\n"), None);
}

#[test]
fn linux_walk_without_child_lists_reads_the_table_once() {
    let mut parents: Vec<(u32, u32)> = vec![(100, 1)];
    for pid in 101..=160 {
        parents.push((pid, pid - 1));
    }
    for pid in 900..1000 {
        parents.push((pid, 1));
    }
    let listing = machine(&parents);
    let walk = LinuxWalk::new(listing);
    let mut found = Vec::new();
    let mut queue = vec![100u32];
    while let Some(next) = queue.pop() {
        for child in walk.children(next) {
            found.push(child);
            queue.push(child);
        }
    }
    found.sort_unstable();
    assert_eq!(found, (101..=160).collect::<Vec<_>>());
    assert_eq!(table_reads(&walk), 1);
}

#[test]
fn windows_identity_is_creation_time() {
    let listing = WindowsListing::new(|pid| (pid == 42).then(|| "133700000000000000".to_owned()));
    assert_eq!(
        listing.info(42),
        Some(ProcessInfo {
            start: "133700000000000000".to_owned(),
            parent: 0,
            group: 42,
            zombie: false,
        })
    );
    assert_eq!(listing.info(43), None);
}
