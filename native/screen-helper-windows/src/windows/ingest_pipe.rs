//! ace-media's ingest named pipe, as the shell's `Link`. The client asks for identification-
//! level impersonation only, so the pipe's server can never act as this user.
use crate::media::shell::{Cancel, Link};
use std::{
    fs::File,
    io::{self, Write},
    os::windows::io::{AsRawHandle, FromRawHandle},
    sync::Arc,
};
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{ERROR_PIPE_BUSY, GENERIC_READ, GENERIC_WRITE, HANDLE},
        Storage::FileSystem::{
            CreateFileW, FlushFileBuffers, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_NONE,
            OPEN_EXISTING, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
        },
        System::{
            Pipes::{PeekNamedPipe, WaitNamedPipeW},
            IO::CancelIoEx,
        },
    },
};

/// Shared by the link and its cancel, so the handle closes only once neither can use it.
struct Pipe(File);

impl Pipe {
    fn handle(&self) -> HANDLE {
        HANDLE(self.0.as_raw_handle())
    }
}

pub struct PipeLink(Arc<Pipe>);
pub struct PipeCancel(Arc<Pipe>);

impl Link for PipeLink {
    fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        (&self.0 .0).write_all(bytes)
    }
    fn alive(&mut self) -> bool {
        // A closed server end fails the peek with ERROR_BROKEN_PIPE; it never blocks.
        unsafe { PeekNamedPipe(self.0.handle(), None, 0, None, None, None) }.is_ok()
    }
    fn finish(&mut self) {
        // Waits until ace-media has read every byte, then the handle closes with the link.
        let _ = unsafe { FlushFileBuffers(self.0.handle()) };
    }
}

impl Cancel for PipeCancel {
    fn cancel(&self) {
        // Ends a blocking write to a reader that stopped reading.
        let _ = unsafe { CancelIoEx(self.0.handle(), None) };
    }
}

pub fn dial(name: &str, server: Option<u32>) -> io::Result<(Box<dyn Link>, Arc<dyn Cancel>)> {
    let _ = server;
    let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    let mut attempts = 0;
    let handle = loop {
        let opened = unsafe {
            CreateFileW(
                PCWSTR(wide.as_ptr()),
                (GENERIC_READ | GENERIC_WRITE).0,
                FILE_SHARE_NONE,
                None,
                OPEN_EXISTING,
                FILE_FLAGS_AND_ATTRIBUTES(SECURITY_SQOS_PRESENT.0 | SECURITY_IDENTIFICATION.0),
                HANDLE::default(),
            )
        };
        match opened {
            Ok(handle) => break handle,
            // Every instance is taken: wait for one, briefly, once or twice.
            Err(error)
                if error.code() == windows::core::HRESULT::from_win32(ERROR_PIPE_BUSY.0)
                    && attempts < 2 =>
            {
                attempts += 1;
                let _ = unsafe { WaitNamedPipeW(PCWSTR(wide.as_ptr()), 500) };
            }
            Err(error) => return Err(io::Error::from_raw_os_error(error.code().0 & 0xffff)),
        }
    };
    let pipe = Arc::new(Pipe(unsafe { File::from_raw_handle(handle.0) }));
    Ok((Box::new(PipeLink(pipe.clone())), Arc::new(PipeCancel(pipe))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::{
        Foundation::{CloseHandle, ERROR_BROKEN_PIPE, ERROR_PIPE_LISTENING},
        Storage::FileSystem::{ReadFile, PIPE_ACCESS_DUPLEX},
        System::Pipes::{CreateNamedPipeW, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT},
    };

    /// A server instance of `name` that this test process owns: a squatter, for any other pid.
    fn serve(name: &str) -> HANDLE {
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        let handle = unsafe {
            CreateNamedPipeW(
                PCWSTR(wide.as_ptr()),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_WAIT,
                PIPE_UNLIMITED_INSTANCES,
                0,
                65_536,
                0,
                None,
            )
        };
        assert!(!handle.is_invalid());
        handle
    }

    /// Bytes the server got before its client went away.
    fn received(server: HANDLE) -> usize {
        let mut buffer = [0u8; 256];
        let mut read = 0u32;
        match unsafe { ReadFile(server, Some(&mut buffer), Some(&mut read), None) } {
            Ok(()) => read as usize,
            // Never connected, or connected and gone with nothing written.
            Err(error) => {
                let code = error.code();
                assert!(
                    [ERROR_BROKEN_PIPE.0, ERROR_PIPE_LISTENING.0]
                        .iter()
                        .any(|e| code == windows::core::HRESULT::from_win32(*e)),
                    "{error}"
                );
                0
            }
        }
    }

    #[test]
    fn a_pipe_served_by_another_process_is_refused_before_any_byte_is_sent() {
        let name = format!(r"\\.\pipe\ace-e1-squat-{}", std::process::id());
        let squatter = serve(&name);
        // The daemon says ace-media is pid 4, the System process: this server is not it.
        let refused = dial(&name, Some(4));
        assert!(
            refused.is_err(),
            "connected to a server that is not ace-media"
        );
        assert_eq!(received(squatter), 0);
        unsafe {
            let _ = CloseHandle(squatter);
        }
    }

    #[test]
    fn the_trusted_server_is_accepted_and_gets_the_bytes() {
        let name = format!(r"\\.\pipe\ace-e1-trusted-{}", std::process::id());
        let server = serve(&name);
        let (mut link, _cancel) = dial(&name, Some(std::process::id())).expect("trusted server");
        link.write_all(b"hello").unwrap();
        assert_eq!(received(server), 5);
        drop(link);
        unsafe {
            let _ = CloseHandle(server);
        }
    }
}
