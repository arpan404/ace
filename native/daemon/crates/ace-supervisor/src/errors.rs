// SPDX-License-Identifier: Apache-2.0
//! Shared error type for process supervision: one typed enum, mapped in the binding.

/// What a supervision call failed with. Messages stay stable for the shell's warnings.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SupervisorError {
    /// A caller gave a value the kernel or schema cannot take.
    #[error("invalid process input: {0}")]
    InvalidInput(String),
    /// The kernel would not say what was asked (an unreadable process, a refused probe).
    #[error("kernel process unavailable: {0}")]
    Unavailable(String),
    /// Spawning, signalling or waiting on the OS failed.
    #[error("process operation failed: {0}")]
    Operation(String),
    /// The journal (SQLite) refused a read or write.
    #[error("process journal failed: {0}")]
    Journal(String),
    /// The inventory is full (4,096 rows), or a launch exceeds the kernel's limits.
    #[error("process limit reached: {0}")]
    Limit(String),
    /// The handle is closed; the process it owned is gone from supervision.
    #[error("supervision handle is closed")]
    Closed,
}

impl SupervisorError {
    /// Wraps an OS error with what was being done.
    pub fn operation(action: &str, error: std::io::Error) -> Self {
        Self::Operation(format!("{action}: {error}"))
    }

    /// Wraps a journal error with what was being done.
    pub fn journal(action: &str, error: ace_store::Error) -> Self {
        Self::Journal(format!("{action}: {error}"))
    }
}

impl From<SupervisorError> for String {
    fn from(error: SupervisorError) -> Self {
        error.to_string()
    }
}

/// A failed I/O call in the shape node's streams report it: the errno's name
/// (`EPIPE`), the raw `errno`, and the message a stream write carries
/// (`write EPIPE`). The shell sets the JS error's `code` and `errno` from it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeIoError {
    syscall: &'static str,
    code: Option<&'static str>,
    errno: Option<i32>,
    message: String,
}

impl NodeIoError {
    /// `syscall` failed with `error`: node's name for the errno and the text
    /// node's own write reports, or today's OS text when no name is known.
    pub fn new(syscall: &'static str, error: &std::io::Error) -> Self {
        let code = errno_name(error);
        let message = match code {
            Some(code) => format!("{syscall} {code}"),
            None => error.to_string(),
        };
        Self {
            syscall,
            code,
            errno: error.raw_os_error(),
            message,
        }
    }

    /// The JSON the shell parses; a field that is unknown stays out.
    pub fn to_json(&self) -> String {
        let mut fields = serde_json::Map::new();
        fields.insert("syscall".to_owned(), self.syscall.into());
        fields.insert("message".to_owned(), self.message.clone().into());
        if let Some(code) = self.code {
            fields.insert("code".to_owned(), code.into());
        }
        if let Some(errno) = self.errno {
            fields.insert("errno".to_owned(), errno.into());
        }
        serde_json::Value::Object(fields).to_string()
    }
}

/// Node's errno name for an I/O failure: the standard library's kind first
/// (it is the portable classification), then the raw errno for the errors it
/// leaves unclassified.
fn errno_name(error: &std::io::Error) -> Option<&'static str> {
    match error.kind() {
        std::io::ErrorKind::PermissionDenied => Some("EACCES"),
        std::io::ErrorKind::NotFound => Some("ENOENT"),
        std::io::ErrorKind::Interrupted => Some("EINTR"),
        std::io::ErrorKind::WouldBlock => Some("EAGAIN"),
        std::io::ErrorKind::AlreadyExists => Some("EEXIST"),
        std::io::ErrorKind::BrokenPipe => Some("EPIPE"),
        std::io::ErrorKind::InvalidInput => Some("EINVAL"),
        std::io::ErrorKind::InvalidData => Some("EINVAL"),
        std::io::ErrorKind::TimedOut => Some("ETIMEDOUT"),
        std::io::ErrorKind::WriteZero => Some("EIO"),
        std::io::ErrorKind::OutOfMemory => Some("ENOMEM"),
        std::io::ErrorKind::StorageFull => Some("ENOSPC"),
        std::io::ErrorKind::ConnectionAborted => Some("ECONNABORTED"),
        std::io::ErrorKind::ConnectionReset => Some("ECONNRESET"),
        std::io::ErrorKind::ConnectionRefused => Some("ECONNREFUSED"),
        std::io::ErrorKind::NotConnected => Some("ENOTCONN"),
        std::io::ErrorKind::AddrInUse => Some("EADDRINUSE"),
        std::io::ErrorKind::AddrNotAvailable => Some("EADDRNOTAVAIL"),
        std::io::ErrorKind::NetworkDown => Some("ENETDOWN"),
        std::io::ErrorKind::NetworkUnreachable => Some("ENETUNREACH"),
        std::io::ErrorKind::HostUnreachable => Some("EHOSTUNREACH"),
        _ => raw_errno_name(error.raw_os_error()?),
    }
}

/// The errno names node has and the standard library does not classify.
#[cfg(unix)]
fn raw_errno_name(errno: i32) -> Option<&'static str> {
    use rustix::io::Errno;
    [
        (Errno::PIPE, "EPIPE"),
        (Errno::CONNRESET, "ECONNRESET"),
        (Errno::CONNABORTED, "ECONNABORTED"),
        (Errno::NOTCONN, "ENOTCONN"),
        (Errno::CONNREFUSED, "ECONNREFUSED"),
        (Errno::AGAIN, "EAGAIN"),
        (Errno::INTR, "EINTR"),
        (Errno::ACCESS, "EACCES"),
        (Errno::NOENT, "ENOENT"),
        (Errno::INVAL, "EINVAL"),
        (Errno::IO, "EIO"),
        (Errno::NOSPC, "ENOSPC"),
        (Errno::TIMEDOUT, "ETIMEDOUT"),
        (Errno::NXIO, "ENXIO"),
        (Errno::NODEV, "ENODEV"),
        (Errno::MFILE, "EMFILE"),
        (Errno::NFILE, "ENFILE"),
        (Errno::FBIG, "EFBIG"),
        (Errno::TXTBSY, "ETXTBSY"),
        (Errno::ROFS, "EROFS"),
        (Errno::DQUOT, "EDQUOT"),
        (Errno::SPIPE, "ESPIPE"),
        (Errno::LOOP, "ELOOP"),
        (Errno::MSGSIZE, "EMSGSIZE"),
        (Errno::NOTSOCK, "ENOTSOCK"),
        (Errno::AFNOSUPPORT, "EAFNOSUPPORT"),
        (Errno::PROTONOSUPPORT, "EPROTONOSUPPORT"),
        (Errno::NOTSUP, "ENOTSUP"),
    ]
    .into_iter()
    .find(|(candidate, _)| candidate.raw_os_error() == errno)
    .map(|(_, name)| name)
}

#[cfg(not(unix))]
fn raw_errno_name(_errno: i32) -> Option<&'static str> {
    None
}
