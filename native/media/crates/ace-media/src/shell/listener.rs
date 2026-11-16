// SPDX-License-Identifier: Apache-2.0
//! The private sockets' listener, one shape on every platform so the lanes and the ingest
//! socket share their accept and hello code: a Unix socket in the runtime directory, or on
//! Windows a named pipe only the current user may open ([`super::pipe`]).
use std::path::{Path, PathBuf};

/// Which of ace-media's two sockets: the control lanes or producers' ingest.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Control,
    Ingest,
}

impl Role {
    fn suffix(self) -> char {
        match self {
            Role::Control => 'c',
            Role::Ingest => 'i',
        }
    }
}

/// The named pipe for `role`: the pid says whose it is, the nonce makes it unguessable, so no
/// other process can create it first and squat on it.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn pipe_name(pid: u32, nonce: &[u8; 16], role: Role) -> String {
    let mut name = format!(r"\\.\pipe\ace-media-{pid}-");
    for byte in nonce {
        name.push_str(&format!("{byte:02x}"));
    }
    name.push(role.suffix());
    name
}

/// The pipe's security descriptor in SDDL: a protected DACL (nothing inherited) with one
/// entry, read and write for `sid`, the current user. Write includes creating instances.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn pipe_dacl(sid: &str) -> String {
    format!("D:P(A;;GRGW;;;{sid})")
}

/// Where this process's two sockets live. Both names pair, differing only in the role's
/// suffix: `m<pid>c.sock` and `m<pid>i.sock` in the runtime directory (Unix), or two pipes
/// sharing one nonce (Windows).
pub struct Home {
    dir: PathBuf,
    pid: u32,
    #[cfg(windows)]
    nonce: [u8; 16],
}

impl Home {
    pub fn new(dir: &Path, pid: u32) -> std::io::Result<Self> {
        Ok(Self {
            dir: dir.to_path_buf(),
            pid,
            #[cfg(windows)]
            nonce: super::pipe::nonce()?,
        })
    }

    /// What the daemon (or a producer) connects to for `role`.
    pub fn address(&self, role: Role) -> String {
        #[cfg(windows)]
        {
            pipe_name(self.pid, &self.nonce, role)
        }
        #[cfg(not(windows))]
        {
            self.socket_path(role).to_string_lossy().into_owned()
        }
    }

    fn socket_path(&self, role: Role) -> PathBuf {
        self.dir
            .join(format!("m{}{}.sock", self.pid, role.suffix()))
    }

    /// Removes the socket files (a pipe vanishes with its last handle).
    pub fn remove(&self) {
        for role in [Role::Control, Role::Ingest] {
            let _ = std::fs::remove_file(self.socket_path(role));
        }
    }
}

/// Splits an accepted pipe connection into its reading and writing halves (the pipe tests; the
/// shell's lanes split their sealed duplex instead).
#[cfg(all(test, windows))]
pub fn split(
    stream: Stream,
) -> (
    impl tokio::io::AsyncRead + Unpin + Send,
    impl tokio::io::AsyncWrite + Unpin + Send,
) {
    tokio::io::split(stream)
}

#[cfg(windows)]
pub use super::pipe::{Listener, Stream};
#[cfg(unix)]
pub use unix::{Listener, Stream};

#[cfg(unix)]
mod unix {
    use super::{Home, Role};
    use std::path::PathBuf;
    use tokio::net::UnixListener;

    pub type Stream = tokio::net::UnixStream;

    /// Every unix socket path must fit `sun_path` (104 bytes on macOS, with its NUL).
    const SOCKET_PATH_MAX: usize = 103;

    pub struct Listener(UnixListener);

    impl Listener {
        /// Binds a socket that only this user can reach from the moment it exists: the
        /// runtime directory is checked private, and the socket is created under a 0177 umask.
        pub fn bind(home: &Home, role: Role) -> std::io::Result<Self> {
            let path = PathBuf::from(home.address(role));
            if path.as_os_str().len() > SOCKET_PATH_MAX {
                return Err(std::io::Error::other("socket path too long"));
            }
            let _ = std::fs::remove_file(&path);
            let _umask = crate::os::PrivateUmask::set();
            UnixListener::bind(&path).map(Self)
        }

        pub async fn accept(&mut self) -> std::io::Result<Stream> {
            self.0.accept().await.map(|(stream, _)| stream)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipe_names_differ_by_role_and_carry_the_whole_nonce() {
        let nonce = [0xab; 16];
        let control = pipe_name(42, &nonce, Role::Control);
        let ingest = pipe_name(42, &nonce, Role::Ingest);
        assert_eq!(
            control,
            r"\\.\pipe\ace-media-42-ababababababababababababababababc"
        );
        assert_eq!(ingest.strip_suffix('i'), control.strip_suffix('c'));
        let other = pipe_name(42, &[0xac; 16], Role::Control);
        assert_ne!(other, control, "another nonce names another pipe");
    }

    #[test]
    fn the_pipe_admits_only_the_named_user_and_inherits_nothing() {
        assert_eq!(
            pipe_dacl("S-1-5-21-1-2-3-1001"),
            "D:P(A;;GRGW;;;S-1-5-21-1-2-3-1001)"
        );
    }
}
