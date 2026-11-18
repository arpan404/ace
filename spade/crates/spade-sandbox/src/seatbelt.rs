//! macOS's sandbox (ADR 0167 decision 1): a Seatbelt profile made from a [`Policy`], passed to
//! `/usr/bin/sandbox-exec -p`. Pure: the profile is text, tested on every platform; only the
//! runner starts it. In a profile the last rule that matches wins, so the order below is the
//! policy: everything readable, the home folder hidden, granted places opened again, the
//! deny-list closed, the workspace opened again.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use crate::policy::Policy;

/// The program that applies a profile and runs the command under it.
pub const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// System services a command needs: user and group lookups, logging, notifications, and
/// certificate checks for TLS. Nothing that starts apps (LaunchServices), sends Apple Events or
/// reads the keychain (`com.apple.SecurityServer`).
const SERVICES: &[&str] = &[
    "com.apple.system.opendirectoryd.libinfo",
    "com.apple.system.DirectoryService.libinfo_v1",
    "com.apple.system.logger",
    "com.apple.system.notification_center",
    "com.apple.trustd",
    "com.apple.trustd.agent",
];

/// The system's folders, read-only: programs, libraries, frameworks, the system's settings, the
/// developer tools and Homebrew. Not `/Users`, `/Volumes`, `/private/var` (but for the time zones
/// and the developer tools' link) or `/private/tmp`.
const SYSTEM_READ: &[&str] = &[
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/Library",
    "/opt",
    "/nix",
    "/private/etc",
    "/private/var/db/timezone",
    "/private/var/select",
    "/Applications/Xcode.app",
];

/// Single system files read the same way.
const SYSTEM_READ_FILES: &[&str] = &["/private/var/db/xcode_select_link"];

/// Links at the root to `/private`, and folders above the system's, looked up only.
const ROOT_LINKS: &[&str] = &[
    "/etc",
    "/var",
    "/tmp",
    "/private",
    "/private/var",
    "/private/var/db",
    "/Applications",
];

/// The system folders a read-only settled command may read (ADR 0172, amendment 7): the program
/// trees, the shared libraries and the dyld shared cache it needs to start, and nothing else. Not
/// `/Library`, `/opt`, `/private/etc` or Xcode — a read-only run has no reason to read them and
/// they can hold the person's data.
const READ_ONLY_SYSTEM_READ: &[&str] = &["/System", "/usr/lib", "/usr/bin", "/bin", "/usr/libexec"];

/// Links a read-only run reads exactly (not the folder they live in): macOS's `/bin/sh` is a
/// trampoline that reads `/private/var/select/sh`, and the developer-tools shims read the active
/// developer-dir link. Allowing the links alone lets the shell and `xcode-select` resolve without
/// opening `/private/var/select` or `/var/db` as a tree (ADR 0172, amendment 7).
const READ_ONLY_LINKS: &[&str] = &[
    "/private/var/select/sh",
    "/private/var/select/developer_dir",
    "/var/db/xcode_select_link",
];

/// Device nodes every command may read and write.
const DEVICES: &[&str] = &["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"];

/// The profile for `policy`.
pub fn profile(policy: &Policy, read_only: bool) -> String {
    profile_in(policy, read_only, read_only)
}

/// The profile for a normal run of `policy` with no network rule at all (ADR 0171, amendment 4):
/// no outbound connection (the proxy, loopback and Unix sockets included), no bind, no inbound.
pub fn profile_offline(policy: &Policy) -> String {
    profile_in(policy, false, true)
}

fn profile_in(policy: &Policy, read_only: bool, offline: bool) -> String {
    let mut out = String::from("(version 1)\n(deny default)\n");
    out.push_str(
        "(allow process-exec process-fork)\n\
         (allow signal (target same-sandbox))\n\
         (allow process-info* (target same-sandbox))\n\
         (allow sysctl-read)\n",
    );
    // A read-only settled run is minimal and offline (ADR 0172, amendment 7): it gets no POSIX
    // semaphore or notification-center shared memory, and no named Mach service — the kept read
    // programs start without any (user and group lookups degrade like a missing `/etc/passwd`; a
    // normal run keeps `opendirectoryd` for them, `trustd` for TLS revocation, the logger and
    // notification services). If a settled program is found to need one exact service, add only
    // that one here with the reason.
    if !read_only {
        out.push_str(
            "(allow ipc-posix-sem)\n\
             (allow ipc-posix-shm-read-data (ipc-posix-name \"apple.shm.notification_center\"))\n",
        );
        rule(
            &mut out,
            "allow mach-lookup",
            SERVICES.iter().map(|s| global(s)),
        );
    }
    // Reads: the system's own folders and what the policy opens, nothing else. The home folders,
    // `/Users/Shared`, other volumes and the person's temporary storage (`/private/var/folders`,
    // `/private/tmp`) are outside every rule. `/` itself is listed (the loader reads it).
    // A read-only run reads only the narrow program and library trees it needs to start, never the
    // broad system folders a normal run may read (ADR 0172, amendment 7).
    let (system_read, system_files): (&[&str], &[&str]) = if read_only {
        (READ_ONLY_SYSTEM_READ, READ_ONLY_LINKS)
    } else {
        (SYSTEM_READ, SYSTEM_READ_FILES)
    };
    rule(
        &mut out,
        "allow file-read*",
        std::iter::once(literal(Path::new("/")))
            .chain(system_read.iter().map(|p| subpath(Path::new(p))))
            .chain(system_files.iter().map(|p| literal(Path::new(p))))
            .chain(policy.readable().map(|p| subpath(p))),
    );
    // The folders above an opened place (and the root's links to `/private`) can be looked up,
    // not listed, so a path inside resolves (`realpath`, `getcwd`).
    rule(
        &mut out,
        "allow file-read-metadata",
        ancestors(policy).iter().map(|p| literal(p)),
    );
    // `/System` is a firmlink union whose `/System/Volumes/Data` is the Data volume (every user's
    // home and files). Seatbelt already matches a read by its resolved path, so a read of
    // `/System/Volumes/Data/<outside the folder>` is refused by the allowlist today; this explicit
    // deny after the `/System` read is defence in depth, so a future broad `/System` grant could
    // not re-expose the person's files by their real path there (ADR 0172, amendment 7). The sealed
    // system content a command needs is under `/System/Library` and `/System/Cryptexes`, not
    // `/System/Volumes/Data`, and the workspace is opened by its normal `/Users…` path.
    if read_only {
        rule(
            &mut out,
            "deny file-read* file-write*",
            std::iter::once(subpath(Path::new("/System/Volumes/Data"))),
        );
    }
    // Writes: granted folders (the workspace comes after the deny-list). A read-only run
    // (ADR 0172, amendment 7) writes nowhere.
    if !read_only {
        rule(
            &mut out,
            "allow file-write*",
            policy.write.iter().map(|p| subpath(p)),
        );
    }
    // The deny-list, closed whatever came before.
    rule(
        &mut out,
        "deny file-read* file-write*",
        policy.deny.iter().map(|p| subpath(p)),
    );
    // A plugin's own folder, inside ace's data, opened again for reading; then the credential
    // places closed once more, so nothing reopened can reach them.
    rule(
        &mut out,
        "allow file-read*",
        policy.reopen.iter().map(|p| subpath(p)),
    );
    if !policy.reopen.is_empty() {
        rule(
            &mut out,
            "deny file-read* file-write*",
            policy.secrets.iter().map(|p| subpath(p)),
        );
    }
    // The workspace and its temporary folder, inside Spade's data folder, opened again:
    // read-write normally, read-only for a settled command.
    rule(
        &mut out,
        if read_only {
            "allow file-read*"
        } else {
            "allow file-read* file-write*"
        },
        std::iter::once(subpath(&policy.workspace))
            .chain(policy.scratch.iter().map(|p| subpath(p))),
    );
    if read_only {
        // A read-only run gets only the null sink, read and write, and no device ioctls: no
        // `/dev/tty*` or `/dev/fd/*`. Its inherited stdio descriptors (pipes to the daemon) need no
        // path rule.
        rule(
            &mut out,
            "allow file-read* file-write*",
            std::iter::once(literal(Path::new("/dev/null"))),
        );
    } else {
        rule(
            &mut out,
            "allow file-read* file-write* file-ioctl",
            DEVICES.iter().map(|d| literal(Path::new(d))).chain([
                "(regex #\"^/dev/fd/\")".to_owned(),
                "(regex #\"^/dev/tty\")".to_owned(),
            ]),
        );
    }
    // Network: an offline run (a read-only one, a sealed plugin server) gets no network rule at
    // all. Otherwise only Spade's proxy on loopback, and listening on loopback (a dev server); no
    // other connection, Unix sockets and DNS included, is.
    if !offline {
        if let Some(port) = policy.proxy_port {
            let _ = writeln!(
                out,
                "(allow network-outbound (remote ip \"localhost:{port}\"))"
            );
        }
        out.push_str(
            "(allow network-bind (local ip \"localhost:*\"))\n\
             (allow network-inbound (local ip \"localhost:*\"))\n",
        );
    }
    out
}

/// One rule over `filters`; nothing when there are none (an empty rule would match everything).
fn rule(out: &mut String, head: &str, filters: impl Iterator<Item = String>) {
    let filters: Vec<String> = filters.collect();
    if filters.is_empty() {
        return;
    }
    let _ = write!(out, "({head}");
    for filter in filters {
        let _ = write!(out, "\n  {filter}");
    }
    out.push_str(")\n");
}

fn subpath(path: &Path) -> String {
    format!("(subpath {})", quoted(path))
}

fn literal(path: &Path) -> String {
    format!("(literal {})", quoted(path))
}

fn global(name: &str) -> String {
    format!("(global-name {})", string(name))
}

fn quoted(path: &Path) -> String {
    string(&path.to_string_lossy())
}

/// A profile string: backslashes and quotes escaped, so a path can't end the string early.
fn string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The folders above every place the policy opens, up to the root.
fn ancestors(policy: &Policy) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = policy
        .readable()
        .chain(policy.scratch.iter())
        .flat_map(|p| p.ancestors().skip(1).map(Path::to_path_buf))
        .chain(ROOT_LINKS.iter().map(PathBuf::from))
        .collect();
    out.sort();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> Policy {
        Policy {
            workspace: "/Users/p/spade/workspace/b1".into(),
            temp: "/Users/p/spade/workspace/b1/.spade/tmp".into(),
            write: vec!["/Users/p/code/app".into()],
            read: vec!["/Users/p/.cargo/bin".into()],
            hide: vec!["/Users/p".into()],
            deny: vec!["/Users/p/.ssh".into(), "/Users/p/spade".into()],
            secrets: vec!["/Users/p/.ssh".into()],
            reopen: vec![],
            scratch: vec![],
            proxy_port: Some(4100),
        }
    }

    fn position(profile: &str, needle: &str) -> usize {
        profile
            .find(needle)
            .unwrap_or_else(|| panic!("{needle} missing from\n{profile}"))
    }

    #[test]
    fn the_deny_list_comes_after_every_grant_and_the_workspace_after_the_deny_list() {
        let text = profile(&policy(), false);
        let open = position(&text, "(allow file-read*\n  (literal \"/\")");
        let deny = position(
            &text,
            "(deny file-read* file-write*\n  (subpath \"/Users/p/.ssh\")",
        );
        let workspace = position(
            &text,
            "(allow file-read* file-write*\n  (subpath \"/Users/p/spade/workspace/b1\"))",
        );
        assert!(open < deny && deny < workspace);
        assert!(text.starts_with("(version 1)\n(deny default)\n"));
    }

    #[test]
    fn reads_are_the_systems_folders_and_what_the_policy_opens_never_everything() {
        let text = profile(&policy(), false);
        assert!(!text.contains("(allow file-read*)"));
        for opened in [
            "/System",
            "/usr",
            "/Users/p/spade/workspace/b1",
            "/Users/p/.cargo/bin",
        ] {
            assert!(
                text.contains(&format!("(subpath \"{opened}\")")),
                "{opened}"
            );
        }
        for closed in [
            "/Users\"",
            "/Users/p\"",
            "/Volumes",
            "/private/var/folders",
            "/private/tmp\"",
        ] {
            assert!(!text.contains(&format!("(subpath \"{closed}")), "{closed}");
        }
    }

    #[test]
    fn an_offline_run_gets_no_network_rule_but_writes_as_a_normal_run_does() {
        let normal = profile(&policy(), false);
        let offline = profile_offline(&policy());
        for network in ["network-outbound", "network-bind", "network-inbound"] {
            assert!(normal.contains(network), "{network}");
            assert!(!offline.contains(network), "{network}");
        }
        // Everything else is the normal run's: its writes and services stay.
        assert_eq!(
            offline.matches("file-write").count(),
            normal.matches("file-write").count()
        );
        assert!(offline.contains("mach-lookup"));
    }

    #[test]
    fn only_the_proxy_port_is_reachable() {
        let text = profile(&policy(), false);
        assert!(text.contains("(allow network-outbound (remote ip \"localhost:4100\"))"));
        assert_eq!(text.matches("network-outbound").count(), 1);
        let offline = profile(
            &Policy {
                proxy_port: None,
                ..policy()
            },
            false,
        );
        assert!(!offline.contains("network-outbound"));
    }

    #[test]
    fn nothing_starts_apps_sends_apple_events_or_reads_the_keychain() {
        let text = profile(&policy(), false);
        for absent in [
            "launchservices",
            "appleevent",
            "SecurityServer",
            "(allow default)",
        ] {
            assert!(!text.contains(absent), "{absent}");
        }
    }

    #[test]
    fn a_quote_in_a_path_cannot_end_its_string() {
        let text = profile(
            &Policy {
                write: vec!["/Users/p/a\") (allow default) (\"".into()],
                ..policy()
            },
            false,
        );
        assert!(!text.contains("(allow default)\")"));
        assert!(text.contains("a\\\") (allow default) (\\\""));
    }

    #[test]
    fn the_folders_above_a_grant_can_be_looked_up_but_not_listed() {
        let text = profile(&policy(), false);
        assert!(text.contains("(allow file-read-metadata"));
        assert!(text.contains("(literal \"/Users/p/code\")"));
        assert!(text.contains("(literal \"/Users\")"));
    }

    // The read-only profile is tested by its generated text here: a Mac to run Seatbelt on was not
    // available, so these assert the policy the profile encodes (ADR 0172, amendment 7).

    #[test]
    fn read_only_reads_only_the_narrow_program_trees_not_the_broad_system_folders() {
        let text = profile(&policy(), true);
        for opened in ["/System", "/usr/lib", "/usr/bin", "/bin"] {
            assert!(
                text.contains(&format!("(subpath \"{opened}\")")),
                "{opened}"
            );
        }
        // The broad folders a normal run may read are closed to a read-only run: they can hold the
        // person's data.
        for closed in [
            "/Library",
            "/opt",
            "/private/etc",
            "/Applications/Xcode.app",
        ] {
            assert!(
                !text.contains(&format!("(subpath \"{closed}\")")),
                "{closed} should not be opened read-only"
            );
        }
    }

    #[test]
    fn read_only_allows_the_shell_and_developer_dir_links_but_not_their_folders() {
        let text = profile(&policy(), true);
        // The exact links the `/bin/sh` trampoline and the developer-tools shims read.
        for link in [
            "/private/var/select/sh",
            "/private/var/select/developer_dir",
            "/var/db/xcode_select_link",
        ] {
            assert!(text.contains(&format!("(literal \"{link}\")")), "{link}");
        }
        // The folders they live in are not opened as a tree.
        for tree in ["/private/var/select\"", "/var/db\""] {
            assert!(!text.contains(&format!("(subpath \"{tree}")), "{tree}");
        }
    }

    #[test]
    fn read_only_opens_only_the_null_sink_and_no_tty_or_ioctl() {
        let text = profile(&policy(), true);
        assert!(text.contains("(allow file-read* file-write*\n  (literal \"/dev/null\"))"));
        for absent in ["/dev/fd/", "/dev/tty", "/dev/urandom", "file-ioctl"] {
            assert!(
                !text.contains(absent),
                "{absent} should be closed to a read-only run"
            );
        }
    }

    #[test]
    fn read_only_omits_the_semaphore_notification_and_mach_services() {
        let normal = profile(&policy(), false);
        // A normal run keeps them.
        assert!(normal.contains("(allow ipc-posix-sem)"));
        assert!(normal.contains("(allow mach-lookup"));
        assert!(normal.contains("apple.shm.notification_center"));
        // A read-only run gets none of them.
        let text = profile(&policy(), true);
        for absent in [
            "ipc-posix-sem",
            "mach-lookup",
            "notification_center",
            "opendirectoryd",
            "trustd",
        ] {
            assert!(
                !text.contains(absent),
                "{absent} should be absent read-only"
            );
        }
    }

    #[test]
    fn read_only_denies_the_data_volume_firmlink() {
        let text = profile(&policy(), true);
        // `/System` is readable for the sealed system content, but `/System/Volumes/Data` (every
        // user's files, reachable by real path) is denied after it, as defence in depth.
        assert!(text.contains("(subpath \"/System\")"));
        assert!(
            text.contains("(deny file-read* file-write*\n  (subpath \"/System/Volumes/Data\"))")
        );
        // The deny comes after the `/System` read, so it wins.
        let allow = position(&text, "(subpath \"/System\")");
        let deny = position(&text, "(subpath \"/System/Volumes/Data\")");
        assert!(
            allow < deny,
            "the /System/Volumes/Data deny must come after the /System read"
        );
        // A normal run has no such deny (its firmlink handling is a separate concern).
        assert!(!profile(&policy(), false).contains("(subpath \"/System/Volumes/Data\")"));
    }

    #[test]
    fn read_only_grants_no_network_at_all() {
        // Even with a proxy port set, a read-only run gets no outbound, bind or inbound rule.
        let text = profile(
            &Policy {
                proxy_port: Some(4100),
                ..policy()
            },
            true,
        );
        for absent in ["network-outbound", "network-bind", "network-inbound"] {
            assert!(
                !text.contains(absent),
                "{absent} should be absent read-only"
            );
        }
    }

    #[test]
    fn read_only_writes_nowhere() {
        let text = profile(&policy(), true);
        // No write grant on the granted folder or the workspace.
        assert!(!text.contains("(allow file-write*"));
        assert!(
            !text.contains("file-read* file-write*\n  (subpath \"/Users/p/spade/workspace/b1\")")
        );
        assert!(text.contains("(allow file-read*\n  (subpath \"/Users/p/spade/workspace/b1\"))"));
    }
}
