use crate::errors::{Code, Error, Result};
use std::{
    fs::File,
    os::windows::io::{AsRawHandle, FromRawHandle},
    sync::{Arc, Condvar, Mutex},
};
use windows::{
    core::{PCWSTR, PWSTR},
    Win32::{
        Foundation::*,
        Security::{Authorization::*, *},
        Storage::FileSystem::*,
        System::{Pipes::*, Threading::*},
    },
};
/// One pending packet plus one being written. Replacing pending data cannot truncate a packet.
#[derive(Clone)]
pub struct Writer {
    slot: Arc<(Mutex<Option<Vec<u8>>>, Condvar)>,
}
impl Writer {
    pub fn open(endpoint: &str) -> Result<Self> {
        let path = endpoint
            .strip_prefix("pipe:")
            .filter(|v| v.starts_with(r"\\.\pipe\ace-screen-"))
            .ok_or_else(|| Error::new(Code::Bounds, "Expected local ace-screen pipe endpoint"))?;
        if path.len() > 240 || path[20..].contains(['\\', '/', '\0']) {
            return Err(Error::new(Code::Bounds, "Invalid pipe name"));
        }
        let mut file = create(path)?;
        let slot = Arc::new((Mutex::new(None::<Vec<u8>>), Condvar::new()));
        let worker = slot.clone();
        std::thread::spawn(move || {
            use std::io::Write;
            // File owns the handle throughout connection and writes.
            let connected = unsafe { ConnectNamedPipe(HANDLE(file.as_raw_handle()), None) };
            if let Err(e) = connected {
                if e.code() != windows::core::HRESULT::from_win32(ERROR_PIPE_CONNECTED.0) {
                    std::process::exit(1);
                }
            }
            loop {
                let (lock, wake) = &*worker;
                let mut pending = lock.lock().unwrap_or_else(|e| e.into_inner());
                while pending.is_none() {
                    pending = wake.wait(pending).unwrap_or_else(|e| e.into_inner());
                }
                if let Some(packet) = pending.take() {
                    drop(pending);
                    if file.write_all(&packet).is_err() {
                        std::process::exit(1);
                    }
                }
            }
        });
        Ok(Self { slot })
    }
    pub fn publish(&self, packet: Vec<u8>) {
        let (lock, wake) = &*self.slot;
        *lock.lock().unwrap_or_else(|e| e.into_inner()) = Some(packet);
        wake.notify_one();
    }
}
fn create(path: &str) -> Result<File> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)?;
        let token_result = user_sid(token);
        let _ = CloseHandle(token);
        let sid = token_result?;
        let sddl: Vec<u16> = format!("D:P(A;;GRGW;;;{sid})")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(sddl.as_ptr()),
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )?;
        let attrs = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: false.into(),
        };
        let name: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
        let handle = CreateNamedPipeW(
            PCWSTR(name.as_ptr()),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            65536,
            0,
            0,
            Some(&attrs),
        );
        let error = windows::core::Error::from_win32();
        let _ = LocalFree(HLOCAL(descriptor.0));
        if handle == INVALID_HANDLE_VALUE {
            return Err(error.into());
        }
        Ok(File::from_raw_handle(handle.0))
    }
}
unsafe fn user_sid(token: HANDLE) -> Result<String> {
    let mut length = 0;
    let _ = GetTokenInformation(token, TokenUser, None, 0, &mut length);
    if length == 0 || length > 65536 {
        return Err(Error::new(Code::Internal, "Invalid token length"));
    }
    let mut data = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
    GetTokenInformation(
        token,
        TokenUser,
        Some(data.as_mut_ptr().cast()),
        length,
        &mut length,
    )?;
    let user = &*data.as_ptr().cast::<TOKEN_USER>();
    let mut string = PWSTR::null();
    ConvertSidToStringSidW(user.User.Sid, &mut string)?;
    let result = string
        .to_string()
        .map_err(|e| Error::new(Code::Internal, e.to_string()));
    let _ = LocalFree(HLOCAL(string.0.cast()));
    result
}
