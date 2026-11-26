// SPDX-License-Identifier: Apache-2.0
//! Who is on the other end of a local request (`apps/daemon/src/peer-process.ts`):
//! loopback TCP carries no peer credentials, so a stop request's claimed caller is
//! checked instead. The claimed process must hold the client end of this exact
//! connection, and its real ancestry must match the list it sent; anything else
//! verifies nobody, and nothing is spared.
//!
//! Linux reads the claimed process's own `/proc` view; macOS asks `lsof` about that
//! one process. The pure decision is [`verified_with`], so the rules are testable
//! without either.

/// A loopback connection as the server sees it: the client's port and the port
/// the client connected to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Connection {
    pub remote_port: u16,
    pub local_port: u16,
}

/// A process pinned by pid and kernel start.
pub type Member = (i64, String);

/// `verifiedCaller`: the chain to spare, or empty when unproven.
pub fn verified(hint: &[Member], connection: Connection) -> Vec<Member> {
    verified_with(
        hint,
        connection,
        |pid| holds_connection(pid, connection),
        real_chain,
    )
}

/// The decision, with the two reads injected.
pub fn verified_with(
    hint: &[Member],
    _connection: Connection,
    holds: impl Fn(i64) -> bool,
    chain_of: impl Fn(i64) -> Vec<Member>,
) -> Vec<Member> {
    let Some(claimed) = hint.first() else {
        return Vec::new();
    };
    if !holds(claimed.0) {
        return Vec::new();
    }
    let chain = chain_of(claimed.0);
    if chain.len() == hint.len()
        && chain
            .iter()
            .zip(hint)
            .all(|(real, told)| real.0 == told.0 && real.1 == told.1)
    {
        chain
    } else {
        Vec::new()
    }
}

/// The caller chain a `POST /v1/stop` body may carry (`StopRequest`): the client's
/// hint naming the process that holds its connection.
pub fn caller_from(body: &serde_json::Value) -> Vec<Member> {
    body.get("caller")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let pid = item.get("pid")?.as_i64()?;
                    let start = item.get("start")?.as_str()?;
                    Some((pid, start.to_owned()))
                })
                .take(64)
                .collect()
        })
        .unwrap_or_default()
}

/// `pid` and its real ancestors, by kernel identity, up to init (`realChain`).
pub fn real_chain(pid: i64) -> Vec<Member> {
    let mut chain = Vec::new();
    let mut next = Some(pid);
    let mut seen = std::collections::HashSet::new();
    while let Some(pid) = next {
        if pid <= 1 || !seen.insert(pid) {
            break;
        }
        let Some(info) = crate::process::info(pid) else {
            break;
        };
        if info.zombie {
            break;
        }
        chain.push((pid, info.start));
        next = i32::try_from(info.parent).ok().map(i64::from);
    }
    chain
}

/// Whether `pid` holds the client end of `connection` (`holdsConnection`).
#[cfg(target_os = "linux")]
fn holds_connection(pid: i64, connection: Connection) -> bool {
    linux_holds(pid, (connection.remote_port, connection.local_port))
}

#[cfg(target_os = "macos")]
fn holds_connection(pid: i64, connection: Connection) -> bool {
    lsof_holds(pid, (connection.remote_port, connection.local_port))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn holds_connection(_pid: i64, _connection: Connection) -> bool {
    false
}

/// `/proc/<pid>/net/tcp{,6}` rows plus that process's socket fds.
#[cfg(target_os = "linux")]
fn linux_holds(pid: i64, client: (u16, u16)) -> bool {
    let mut inodes = Vec::new();
    for name in ["tcp", "tcp6"] {
        let Ok(text) = std::fs::read_to_string(format!("/proc/{pid}/net/{name}")) else {
            continue;
        };
        inodes.extend(
            parse_proc_tcp(&text)
                .into_iter()
                .filter(|row| (row.local_port, row.remote_port) == client)
                .map(|row| row.inode),
        );
    }
    if inodes.is_empty() {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
        return false;
    };
    for entry in entries.flatten() {
        if let Ok(target) = std::fs::read_link(entry.path()) {
            let target = target.to_string_lossy();
            if inodes
                .iter()
                .any(|inode| target == format!("socket:[{inode}]"))
            {
                return true;
            }
        }
    }
    false
}

/// `lsof -Fn` asked about this one process.
#[cfg(target_os = "macos")]
fn lsof_holds(pid: i64, client: (u16, u16)) -> bool {
    let output = std::process::Command::new("/usr/sbin/lsof")
        .args([
            "-nP",
            "-a",
            "-p",
            &pid.to_string(),
            "-iTCP",
            "-sTCP:ESTABLISHED",
            "-Fn",
        ])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output();
    let Ok(output) = output else {
        return false;
    };
    parse_lsof_tcp(&String::from_utf8_lossy(&output.stdout))
        .into_iter()
        .any(|pair| pair == client)
}

/// One established `/proc/net/tcp` row.
#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcRow {
    pub local_port: u16,
    pub remote_port: u16,
    pub inode: u64,
}

/// `/proc/<pid>/net/tcp` or `tcp6`: established sockets' ports and inodes.
#[cfg(any(target_os = "linux", test))]
pub fn parse_proc_tcp(text: &str) -> Vec<ProcRow> {
    let mut rows = Vec::new();
    for line in text.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let (Some(local), Some(remote), Some(state), Some(inode)) =
            (fields.get(1), fields.get(2), fields.get(3), fields.get(9))
        else {
            continue;
        };
        if *state != "01" {
            continue;
        }
        let Ok(inode) = inode.parse::<u64>() else {
            continue;
        };
        rows.push(ProcRow {
            local_port: proc_port(local),
            remote_port: proc_port(remote),
            inode,
        });
    }
    rows
}

#[cfg(any(target_os = "linux", test))]
fn proc_port(address: &str) -> u16 {
    address
        .rsplit_once(':')
        .and_then(|(_, port)| u16::from_str_radix(port, 16).ok())
        .unwrap_or(0)
}

/// `lsof -F n` names of TCP sockets: each `local->remote` pair's ports.
#[cfg(any(target_os = "macos", test))]
pub fn parse_lsof_tcp(text: &str) -> Vec<(u16, u16)> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim().strip_prefix('n')?;
            let (local, remote) = line.split_once("->")?;
            Some((port_of(local)?, port_of(remote)?))
        })
        .collect()
}

#[cfg(any(target_os = "macos", test))]
fn port_of(address: &str) -> Option<u16> {
    address.rsplit_once(':')?.1.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `peer-process.test.ts`: `/proc` rows keep only established sockets and read
    /// the port after the colon in hex.
    #[test]
    fn a_proc_tcp_row_is_read_only_when_established() {
        let text = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:1F90 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 4242 1\n   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4343 1\n";
        let rows = parse_proc_tcp(text);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].local_port, 8080);
        assert_eq!(rows[0].remote_port, 54321);
        assert_eq!(rows[0].inode, 4242);
    }

    /// `peer-process.test.ts`: lsof's `local->remote` names give the ports.
    #[test]
    fn an_lsof_tcp_name_gives_both_ports() {
        let pairs = parse_lsof_tcp("p123\nn127.0.0.1:54321->127.0.0.1:8080\n");
        assert_eq!(pairs, vec![(54321, 8080)]);
    }

    /// `verifiedCaller`: only the exact claimed chain of the process holding the
    /// connection is spared; a wrong first pid, a wrong chain or no hint spares
    /// nobody.
    #[test]
    fn only_the_exact_chain_of_the_connection_holder_is_verified() {
        let connection = Connection {
            remote_port: 54321,
            local_port: 8080,
        };
        let hint = vec![(10, "a".to_owned()), (1, "init".to_owned())];
        let chain = hint.clone();
        assert_eq!(
            verified_with(&hint, connection, |pid| pid == 10, |_| chain.clone()),
            hint
        );
        assert!(verified_with(&hint, connection, |_| false, |_| chain.clone()).is_empty());
        let wrong = vec![(11, "b".to_owned()), (1, "init".to_owned())];
        assert!(verified_with(&wrong, connection, |_| true, |_| chain.clone()).is_empty());
        assert!(verified_with(&[], connection, |_| true, |_| chain.clone()).is_empty());
        assert!(
            verified_with(&hint, connection, |_| true, |_| vec![(10, "a".to_owned())]).is_empty()
        );
    }
}
