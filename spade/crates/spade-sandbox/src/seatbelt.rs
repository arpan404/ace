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

/// Device nodes every command may read and write.
const DEVICES: &[&str] = &["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"];

/// The profile for `policy`.
pub fn profile(policy: &Policy) -> String {
    let mut out = String::from("(version 1)\n(deny default)\n");
    out.push_str(
        "(allow process-exec process-fork)\n\
         (allow signal (target same-sandbox))\n\
         (allow process-info* (target same-sandbox))\n\
         (allow sysctl-read)\n\
         (allow ipc-posix-sem)\n\
         (allow ipc-posix-shm-read-data (ipc-posix-name \"apple.shm.notification_center\"))\n",
    );
    rule(
        &mut out,
        "allow mach-lookup",
        SERVICES.iter().map(|s| global(s)),
    );
    // Reads: everything, then the home folder hidden, then what the policy opens inside it.
    out.push_str("(allow file-read*)\n");
    rule(
        &mut out,
        "deny file-read*",
        policy.hide.iter().map(|p| subpath(p)),
    );
    rule(
        &mut out,
        "allow file-read*",
        policy.readable().map(|p| subpath(p)),
    );
    // A hidden folder's ancestors stay visible to `stat`, so a granted place inside can be
    // reached by its path (`realpath`, `getcwd`).
    rule(
        &mut out,
        "allow file-read-metadata",
        ancestors(policy).iter().map(|p| literal(p)),
    );
    // Writes: granted folders (the workspace comes after the deny-list).
    rule(
        &mut out,
        "allow file-write*",
        policy.write.iter().map(|p| subpath(p)),
    );
    // The deny-list, closed whatever came before.
    rule(
        &mut out,
        "deny file-read* file-write*",
        policy.deny.iter().map(|p| subpath(p)),
    );
    // The workspace and its temporary folder, inside Spade's data folder, opened again.
    rule(
        &mut out,
        "allow file-read* file-write*",
        [subpath(&policy.workspace)].into_iter(),
    );
    rule(
        &mut out,
        "allow file-read* file-write* file-ioctl",
        DEVICES.iter().map(|d| literal(Path::new(d))).chain([
            "(regex #\"^/dev/fd/\")".to_owned(),
            "(regex #\"^/dev/tty\")".to_owned(),
        ]),
    );
    // Network: only Spade's proxy, on loopback. Listening on loopback is allowed (a dev server);
    // no other connection, Unix sockets and DNS included, is.
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
        .flat_map(|p| p.ancestors().skip(1).map(Path::to_path_buf))
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
        let text = profile(&policy());
        let hide = position(&text, "(deny file-read*\n  (subpath \"/Users/p\")");
        let open = position(
            &text,
            "(allow file-read*\n  (subpath \"/Users/p/spade/workspace/b1\")",
        );
        let deny = position(
            &text,
            "(deny file-read* file-write*\n  (subpath \"/Users/p/.ssh\")",
        );
        let workspace = position(
            &text,
            "(allow file-read* file-write*\n  (subpath \"/Users/p/spade/workspace/b1\"))",
        );
        assert!(hide < open && open < deny && deny < workspace);
        assert!(text.starts_with("(version 1)\n(deny default)\n"));
    }

    #[test]
    fn only_the_proxy_port_is_reachable() {
        let text = profile(&policy());
        assert!(text.contains("(allow network-outbound (remote ip \"localhost:4100\"))"));
        assert_eq!(text.matches("network-outbound").count(), 1);
        let offline = profile(&Policy {
            proxy_port: None,
            ..policy()
        });
        assert!(!offline.contains("network-outbound"));
    }

    #[test]
    fn nothing_starts_apps_sends_apple_events_or_reads_the_keychain() {
        let text = profile(&policy());
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
        let text = profile(&Policy {
            write: vec!["/Users/p/a\") (allow default) (\"".into()],
            ..policy()
        });
        assert!(!text.contains("(allow default)\")"));
        assert!(text.contains("a\\\") (allow default) (\\\""));
    }

    #[test]
    fn the_folders_above_a_grant_can_be_looked_up_but_not_listed() {
        let text = profile(&policy());
        assert!(text.contains("(allow file-read-metadata"));
        assert!(text.contains("(literal \"/Users/p/code\")"));
        assert!(text.contains("(literal \"/Users\")"));
    }
}
