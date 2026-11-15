// SPDX-License-Identifier: Apache-2.0
//! Windows: ace-media's private sockets are named pipes. Each is created with a protected DACL
//! that admits only the current user ([`pipe_dacl`]), refuses remote clients, and claims its
//! unguessable name as the first instance, so creation fails if anyone got there first. Two
//! instances always wait, and each accepted one is replaced at once, so a client connecting
//! while another is being accepted still finds a free instance instead of `ERROR_PIPE_BUSY`.
#![allow(unsafe_code)]
use super::listener::{Home, Role, pipe_dacl};
use std::io;
use std::ptr::null_mut;
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::Cryptography::{
    BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    TokenUser,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

pub type Stream = NamedPipeServer;

pub struct Listener {
    name: String,
    waiting: [NamedPipeServer; 2],
    descriptor: Descriptor,
}

impl Listener {
    /// Creates the pipe's first instance, which fails if the name is already taken.
    pub fn bind(home: &Home, role: Role) -> io::Result<Self> {
        let descriptor = Descriptor::from_sddl(&pipe_dacl(&user_sid()?))?;
        let name = home.address(role);
        let first = create(&name, true, &descriptor)?;
        let second = create(&name, false, &descriptor)?;
        Ok(Self {
            name,
            waiting: [first, second],
            descriptor,
        })
    }

    /// The next connected instance, replaced by a fresh one before this returns. If none can be
    /// made, the connected instance stays and is handed out on the next call. (Waiting on a
    /// connect is cancel safe: the connect stays in flight.)
    pub async fn accept(&mut self) -> io::Result<Stream> {
        let (index, connected) = {
            let [a, b] = &self.waiting;
            tokio::select! {
                connected = a.connect() => (0, connected),
                connected = b.connect() => (1, connected),
            }
        };
        let fresh = create(&self.name, false, &self.descriptor)?;
        let used = std::mem::replace(&mut self.waiting[index], fresh);
        connected.map(|()| used)
    }
}

fn create(name: &str, first: bool, descriptor: &Descriptor) -> io::Result<NamedPipeServer> {
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let mut options = ServerOptions::new();
    options
        .first_pipe_instance(first)
        .reject_remote_clients(true);
    // SAFETY: the attributes and the descriptor they point at outlive the call, which only
    // reads them.
    unsafe {
        options.create_with_security_attributes_raw(
            name,
            (&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
        )
    }
}

/// A self-relative security descriptor the system allocated; freed on drop.
struct Descriptor(PSECURITY_DESCRIPTOR);

// SAFETY: the descriptor is immutable after creation and only read by CreateNamedPipeW.
unsafe impl Send for Descriptor {}
// SAFETY: as above.
unsafe impl Sync for Descriptor {}

impl Descriptor {
    fn from_sddl(sddl: &str) -> io::Result<Self> {
        let wide: Vec<u16> = sddl.encode_utf16().chain(std::iter::once(0)).collect();
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        // SAFETY: `wide` is NUL-terminated and lives through the call; the out pointer is
        // valid and the size pointer may be null.
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(descriptor))
    }
}

impl Drop for Descriptor {
    fn drop(&mut self) {
        // SAFETY: allocated by the conversion above with LocalAlloc, freed once.
        unsafe {
            LocalFree(self.0);
        }
    }
}

struct Token(HANDLE);

impl Drop for Token {
    fn drop(&mut self) {
        // SAFETY: a handle OpenProcessToken returned, closed once.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// This process's user, as a string SID (`S-1-5-21-…`).
fn user_sid() -> io::Result<String> {
    let mut handle: HANDLE = null_mut();
    // SAFETY: the pseudo-handle needs no closing; the out pointer is valid.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut handle) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = Token(handle);
    let mut len = 0u32;
    // SAFETY: a size query: no buffer, a valid length pointer. It fails, reporting the size.
    unsafe { GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut len) };
    if len == 0 {
        return Err(io::Error::last_os_error());
    }
    // u64s keep the buffer aligned for TOKEN_USER and the SID that follows it.
    let mut buffer = vec![0u64; (len as usize).div_ceil(8)];
    // SAFETY: the buffer holds at least `len` bytes.
    let ok = unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            len,
            &mut len,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: on success the buffer starts with a TOKEN_USER whose SID points into it.
    let sid = unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    let mut text = null_mut();
    // SAFETY: a valid SID; the out pointer receives a LocalAlloc'd wide string.
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut n = 0;
    // SAFETY: the string is NUL-terminated; read up to the NUL, then free it once.
    let sid = unsafe {
        while *text.add(n) != 0 {
            n += 1;
        }
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, n));
        LocalFree(text.cast());
        sid
    };
    Ok(sid)
}

/// 16 bytes from the system's preferred RNG.
pub fn nonce() -> io::Result<[u8; 16]> {
    let mut bytes = [0u8; 16];
    // SAFETY: a valid 16-byte buffer; no algorithm handle with the system-preferred flag.
    let status = unsafe {
        BCryptGenRandom(
            null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        return Err(io::Error::other(format!("random: status {status:#x}")));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::super::listener::{Home, Role, split};
    use super::Listener;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::windows::named_pipe::ClientOptions;

    #[tokio::test]
    async fn clients_at_once_all_connect_and_split_connections_carry_bytes_both_ways() {
        let home = match Home::new(&std::env::temp_dir(), std::process::id()) {
            Ok(home) => home,
            Err(error) => panic!("home: {error}"),
        };
        let mut listener = match Listener::bind(&home, Role::Control) {
            Ok(listener) => listener,
            Err(error) => panic!("bind: {error}"),
        };
        let name = home.address(Role::Control);
        assert!(
            Listener::bind(&home, Role::Control).is_err(),
            "a second first instance of the same name is refused"
        );
        // Two producers at once: both find an instance before either is accepted.
        let early = [
            ClientOptions::new().open(&name),
            ClientOptions::new().open(&name),
        ];
        assert!(early.iter().all(Result::is_ok), "opens: {early:?}");
        for _ in 0..2 {
            assert!(listener.accept().await.is_ok());
        }
        drop(early);
        for round in 0u8..3 {
            let client = ClientOptions::new().open(&name);
            let Ok(mut client) = client else {
                panic!("open {round}: {client:?}")
            };
            let server = match listener.accept().await {
                Ok(server) => server,
                Err(error) => panic!("accept: {error}"),
            };
            let (mut read, mut write) = split(server);
            // A read is pending while the server writes: the lane's shape.
            let reader = tokio::spawn(async move {
                let mut got = [0u8; 4];
                read.read_exact(&mut got).await.map(|_| got)
            });
            tokio::task::yield_now().await;
            assert!(write.write_all(&[round; 3]).await.is_ok());
            let mut echoed = [0u8; 3];
            assert!(client.read_exact(&mut echoed).await.is_ok());
            assert_eq!(echoed, [round; 3]);
            assert!(client.write_all(&[round, 1, 2, 3]).await.is_ok());
            match reader.await {
                Ok(Ok(got)) => assert_eq!(got, [round, 1, 2, 3]),
                other => panic!("read: {other:?}"),
            }
        }
    }
}
