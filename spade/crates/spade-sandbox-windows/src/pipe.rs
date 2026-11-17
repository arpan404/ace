//! A security descriptor that lets one bot's AppContainer SID reach a named pipe, and nothing
//! else but the system and administrators (ADR 0167 decision 3). The daemon's egress proxy
//! listens on a pipe with this descriptor; the in-container bridge is the only other process that
//! can open it, so a run's traffic has exactly one way out and it is scoped to that run's SID.

use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use windows::core::HSTRING;

use crate::sid::Sid;

/// An owned security descriptor and the `SECURITY_ATTRIBUTES` that point at it. Pass
/// [`PipeSecurity::attributes`] to a named-pipe server; keep this alive while the pipe is open.
pub struct PipeSecurity {
    descriptor: PSECURITY_DESCRIPTOR,
    attributes: SECURITY_ATTRIBUTES,
}

// SAFETY: the descriptor is a stable heap allocation this struct owns and frees on drop; it is
// never mutated after construction, so sharing a reference across threads is sound.
unsafe impl Send for PipeSecurity {}
// SAFETY: see the `Send` impl above.
unsafe impl Sync for PipeSecurity {}

impl PipeSecurity {
    /// Grants the system, administrators and `sid` full access to the pipe, and no one else.
    pub fn for_container(sid: &Sid) -> std::io::Result<Self> {
        // Protected DACL: SYSTEM, Administrators and the container SID, nothing inherited.
        let sddl = format!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{sid})");
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        // SAFETY: a NUL-terminated string in; on success `descriptor` is a LocalAlloc'd
        // self-relative descriptor, freed in `Drop`.
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                &HSTRING::from(sddl),
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
        }
        .map_err(crate::io)?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: false.into(),
        };
        Ok(Self {
            descriptor,
            attributes,
        })
    }

    /// A pointer to the `SECURITY_ATTRIBUTES`, for a named-pipe server. Valid while `self` lives.
    pub fn attributes(&self) -> *const core::ffi::c_void {
        std::ptr::from_ref(&self.attributes).cast()
    }
}

/// A byte-mode named-pipe **server** instance at `path` whose DACL is `security` (one bot's
/// container SID). Overlapped (async), so reads and writes can run at once without the
/// serialisation a synchronous pipe handle forces; both ends of the bridge use overlapped I/O for
/// this reason. The unsafe call lives here because the rest of Spade forbids `unsafe`. `first`
/// must be set on the first instance of a name and clear on the rest.
pub fn server(
    path: &str,
    security: &PipeSecurity,
    first: bool,
) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    use tokio::net::windows::named_pipe::ServerOptions;
    // SAFETY: `security` outlives the call; its pointer is a valid SECURITY_ATTRIBUTES with a
    // self-relative descriptor, exactly what the parameter wants.
    unsafe {
        ServerOptions::new()
            .first_pipe_instance(first)
            .create_with_security_attributes_raw(path, security.attributes().cast_mut())
    }
}

impl Drop for PipeSecurity {
    fn drop(&mut self) {
        if !self.descriptor.is_invalid() {
            // SAFETY: allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW.
            unsafe { LocalFree(Some(HLOCAL(self.descriptor.0))) };
        }
    }
}
