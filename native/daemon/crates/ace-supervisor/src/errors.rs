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
/// (`EPIPE`), node's `errno`, and the message a stream write carries
/// (`write EPIPE`). The shell sets the JS error's fields from it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeIoError {
    syscall: &'static str,
    code: &'static str,
    errno: i32,
    message: String,
}

/// `UV__UNKNOWN`: node's errno for a failure that has no name.
const UNKNOWN_ERRNO: i32 = -4094;

impl NodeIoError {
    /// `syscall` failed with `error`: node's name for the errno, node's `errno`
    /// value and the text node's own write reports.
    pub fn new(syscall: &'static str, error: &std::io::Error) -> Self {
        let code = errno_name(error);
        let message = format!("{syscall} {code}");
        Self {
            syscall,
            code,
            errno: node_errno(error),
            message,
        }
    }

    /// The JSON the shell parses.
    pub fn to_json(&self) -> String {
        let mut fields = serde_json::Map::new();
        fields.insert("syscall".to_owned(), self.syscall.into());
        fields.insert("message".to_owned(), self.message.clone().into());
        fields.insert("code".to_owned(), self.code.into());
        fields.insert("errno".to_owned(), self.errno.into());
        serde_json::Value::Object(fields).to_string()
    }
}

/// Node's errno name for an I/O failure, from the raw errno on POSIX: `EPERM`
/// and `EACCES` share a kind, and only the number tells them apart.
#[cfg(not(windows))]
fn errno_name(error: &std::io::Error) -> &'static str {
    match error.raw_os_error() {
        Some(errno) => raw_errno_name(errno).unwrap_or("UNKNOWN"),
        None => kind_name(error.kind()),
    }
}

/// Node's errno name for an I/O failure on Windows, which classifies by kind.
#[cfg(windows)]
fn errno_name(error: &std::io::Error) -> &'static str {
    kind_name(error.kind())
}

/// Node's name for the errors the standard library classifies by kind.
fn kind_name(kind: std::io::ErrorKind) -> &'static str {
    match kind {
        std::io::ErrorKind::PermissionDenied => "EACCES",
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::Interrupted => "EINTR",
        std::io::ErrorKind::WouldBlock => "EAGAIN",
        std::io::ErrorKind::AlreadyExists => "EEXIST",
        std::io::ErrorKind::BrokenPipe => "EPIPE",
        std::io::ErrorKind::InvalidInput => "EINVAL",
        std::io::ErrorKind::InvalidData => "EINVAL",
        std::io::ErrorKind::TimedOut => "ETIMEDOUT",
        std::io::ErrorKind::WriteZero => "EIO",
        std::io::ErrorKind::OutOfMemory => "ENOMEM",
        std::io::ErrorKind::StorageFull => "ENOSPC",
        std::io::ErrorKind::ConnectionAborted => "ECONNABORTED",
        std::io::ErrorKind::ConnectionReset => "ECONNRESET",
        std::io::ErrorKind::ConnectionRefused => "ECONNREFUSED",
        std::io::ErrorKind::NotConnected => "ENOTCONN",
        std::io::ErrorKind::AddrInUse => "EADDRINUSE",
        std::io::ErrorKind::AddrNotAvailable => "EADDRNOTAVAIL",
        std::io::ErrorKind::NetworkDown => "ENETDOWN",
        std::io::ErrorKind::NetworkUnreachable => "ENETUNREACH",
        std::io::ErrorKind::HostUnreachable => "EHOSTUNREACH",
        _ => "UNKNOWN",
    }
}

/// Node's `errno` for a failure: the negated errno, as libuv reports it.
#[cfg(not(windows))]
fn node_errno(error: &std::io::Error) -> i32 {
    error.raw_os_error().map_or(UNKNOWN_ERRNO, |errno| -errno)
}

/// Node's `errno` for a failure: libuv's Windows value for the Win32 error the
/// standard library classified (`uv/errno.h`), else `UV__UNKNOWN`.
#[cfg(windows)]
fn node_errno(error: &std::io::Error) -> i32 {
    match error.kind() {
        std::io::ErrorKind::PermissionDenied => -4092, // UV__EACCES
        std::io::ErrorKind::NotFound => -4058,         // UV__ENOENT
        std::io::ErrorKind::Interrupted => -4072,      // UV__EINTR
        std::io::ErrorKind::WouldBlock => -4088,       // UV__EAGAIN
        std::io::ErrorKind::AlreadyExists => -4075,    // UV__EEXIST
        std::io::ErrorKind::BrokenPipe => -4047,       // UV__EPIPE
        std::io::ErrorKind::InvalidInput | std::io::ErrorKind::InvalidData => -4071, // UV__EINVAL
        std::io::ErrorKind::TimedOut => -4039,         // UV__ETIMEDOUT
        std::io::ErrorKind::WriteZero => -4070,        // UV__EIO
        std::io::ErrorKind::OutOfMemory => -4057,      // UV__ENOMEM
        std::io::ErrorKind::StorageFull => -4055,      // UV__ENOSPC
        std::io::ErrorKind::ConnectionAborted => -4079, // UV__ECONNABORTED
        std::io::ErrorKind::ConnectionReset => -4077,  // UV__ECONNRESET
        std::io::ErrorKind::ConnectionRefused => -4078, // UV__ECONNREFUSED
        std::io::ErrorKind::NotConnected => -4053,     // UV__ENOTCONN
        std::io::ErrorKind::AddrInUse => -4091,        // UV__EADDRINUSE
        std::io::ErrorKind::AddrNotAvailable => -4090, // UV__EADDRNOTAVAIL
        std::io::ErrorKind::NetworkDown => -4063,      // UV__ENETDOWN
        std::io::ErrorKind::NetworkUnreachable => -4062, // UV__ENETUNREACH
        std::io::ErrorKind::HostUnreachable => -4073,  // UV__EHOSTUNREACH
        _ => UNKNOWN_ERRNO,
    }
}

/// The errno names node has, by number: the standard library's kind cannot
/// tell `EPERM` from `EACCES`, so POSIX naming starts from the raw errno.
#[cfg(unix)]
fn raw_errno_name(errno: i32) -> Option<&'static str> {
    use rustix::io::Errno;
    [
        (Errno::PERM, "EPERM"),
        (Errno::NOENT, "ENOENT"),
        (Errno::SRCH, "ESRCH"),
        (Errno::INTR, "EINTR"),
        (Errno::IO, "EIO"),
        (Errno::BADF, "EBADF"),
        (Errno::AGAIN, "EAGAIN"),
        (Errno::NOMEM, "ENOMEM"),
        (Errno::ACCESS, "EACCES"),
        (Errno::EXIST, "EEXIST"),
        (Errno::INVAL, "EINVAL"),
        (Errno::PIPE, "EPIPE"),
        (Errno::CONNRESET, "ECONNRESET"),
        (Errno::CONNABORTED, "ECONNABORTED"),
        (Errno::NOTCONN, "ENOTCONN"),
        (Errno::TIMEDOUT, "ETIMEDOUT"),
        (Errno::CONNREFUSED, "ECONNREFUSED"),
        (Errno::NOSPC, "ENOSPC"),
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
