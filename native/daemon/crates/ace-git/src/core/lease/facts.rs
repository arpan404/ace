// SPDX-License-Identifier: Apache-2.0
//! What Windows tells about a running Git process beyond its name
//! (`packages/git/src/git-process-facts.ts`): its command line and its working
//! directory. The kernel calls are the injected `ProcessFactsApi` (bun:ffi on
//! Windows); this module is the decoding and validation only.
//!
//! The command line comes from `NtQueryInformationProcess(ProcessCommandLineInformation)`.
//! The working directory lives in the process's own parameter block:
//! `ProcessBasicInformation` gives its PEB, whose `ProcessParameters` (offset
//! 0x20) hold `CurrentDirectory.DosPath` at 0x38 as a `UNICODE_STRING`, read
//! with `ReadProcessMemory`. The 64-bit layout is the same on x64 and ARM64.

/// What one process could be read as; either field is absent when unreadable.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GitProcessFacts {
    pub command_line: Option<String>,
    pub cwd: Option<String>,
}

/// The raw Win32 surface `ProcessFactsApi`. Handles are opaque to this module.
pub trait ProcessFactsApi {
    fn open(&self, pid: u32, access: u32) -> i64;
    fn close(&self, handle: i64);
    /// NTSTATUS, 0 on success; returns (status, bytes written).
    fn query(&self, handle: i64, info_class: u32, info: &mut [u8]) -> (i32, u32);
    fn read(&self, handle: i64, address: u64, into: &mut [u8]) -> bool;
    /// Whether the process is 32-bit on 64-bit Windows; `None` when unknown.
    fn wow64(&self, handle: i64) -> Option<bool>;
}

pub const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
pub const PROCESS_VM_READ: u32 = 0x0010;
pub const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
pub const PROCESS_BASIC_INFORMATION: u32 = 0;
pub const PROCESS_COMMAND_LINE_INFORMATION: u32 = 60;
/// `UNICODE_STRING` on 64-bit Windows: Length (bytes) at 0, the buffer pointer at 8.
pub const UNICODE_HEADER_BYTES: usize = 16;
/// A command line is at most 32,767 UTF-16 units.
pub const BUFFER_BYTES: usize = UNICODE_HEADER_BYTES + 65_536;

/// Reads the command line: a `UNICODE_STRING` header followed by its text.
pub fn command_line(buffer: &[u8], returned: u32) -> Option<String> {
    let length = u16::from_le_bytes([*buffer.first()?, *buffer.get(1)?]) as usize;
    if !length.is_multiple_of(2)
        || UNICODE_HEADER_BYTES + length > (returned as usize).min(buffer.len())
    {
        return None;
    }
    utf16_to_string(&buffer[UNICODE_HEADER_BYTES..UNICODE_HEADER_BYTES + length])
}

/// The working directory's path, or `None` for a torn or foreign read.
pub fn working_directory_path(text: &str) -> Option<String> {
    let drive = text.len() > 2
        && text.as_bytes()[0].is_ascii_alphabetic()
        && text.as_bytes()[1] == b':'
        && text.as_bytes()[2] == b'\\';
    let unc = text.starts_with(r"\\") && text.as_bytes().get(2).is_some_and(|c| *c != b'\\');
    if (!drive && !unc) || text.contains('\0') {
        return None;
    }
    // Windows keeps the directory with a trailing separator; a drive root keeps its own.
    if text.len() == 3 && drive {
        return Some(text.to_owned());
    }
    Some(text.trim_end_matches('\\').to_owned())
}

/// Whether this process's directory may be read at all.
pub fn reads_directory(full_access: bool, arch: &str, wow64: Option<bool>) -> bool {
    full_access && arch != "ia32" && arch != "arm" && wow64 == Some(false)
}

/// Facts for one process, with the same access fallback the TS reader uses.
pub fn facts_of(api: &dyn ProcessFactsApi, pid: u32, arch: &str) -> GitProcessFacts {
    let full = api.open(pid, PROCESS_QUERY_INFORMATION | PROCESS_VM_READ);
    let handle = if full > 0 {
        full
    } else {
        api.open(pid, PROCESS_QUERY_LIMITED_INFORMATION)
    };
    if handle <= 0 {
        return GitProcessFacts::default();
    }
    let mut facts = GitProcessFacts::default();
    let mut buffer = vec![0u8; BUFFER_BYTES];
    if let (0, returned) = api.query(handle, PROCESS_COMMAND_LINE_INFORMATION, &mut buffer) {
        facts.command_line = command_line(&buffer, returned);
    }
    if reads_directory(full > 0, arch, api.wow64(handle)) {
        facts.cwd = read_working_directory(api, handle);
    }
    api.close(handle);
    facts
}

fn read_working_directory(api: &dyn ProcessFactsApi, handle: i64) -> Option<String> {
    let mut basic = [0u8; 48];
    let (status, _) = api.query(handle, PROCESS_BASIC_INFORMATION, &mut basic);
    if status != 0 {
        return None;
    }
    let peb = u64::from_le_bytes(basic[8..16].try_into().ok()?);
    if peb == 0 {
        return None;
    }
    let mut pointer = [0u8; 8];
    if !api.read(handle, peb + 0x20, &mut pointer) {
        return None;
    }
    let parameters = u64::from_le_bytes(pointer);
    if parameters == 0 {
        return None;
    }
    let mut header = [0u8; UNICODE_HEADER_BYTES];
    if !api.read(handle, parameters + 0x38, &mut header) {
        return None;
    }
    let length = u16::from_le_bytes([header[0], header[1]]) as usize;
    let address = u64::from_le_bytes(header[8..16].try_into().ok()?);
    if length == 0 || !length.is_multiple_of(2) || address == 0 {
        return None;
    }
    let mut text = vec![0u8; length];
    if !api.read(handle, address, &mut text) {
        return None;
    }
    working_directory_path(&utf16_to_string(&text)?)
}

fn utf16_to_string(bytes: &[u8]) -> Option<String> {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16(&units).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(length: u16, pointer: u64) -> Vec<u8> {
        let mut bytes = vec![0u8; UNICODE_HEADER_BYTES];
        bytes[0..2].copy_from_slice(&length.to_le_bytes());
        bytes[2..4].copy_from_slice(&length.to_le_bytes());
        bytes[8..16].copy_from_slice(&pointer.to_le_bytes());
        bytes
    }

    #[test]
    fn a_command_line_is_the_header_followed_by_its_utf16_text() {
        let text: Vec<u16> = "git.exe status".encode_utf16().collect();
        let mut buffer = header((text.len() * 2) as u16, 0);
        for unit in text {
            buffer.extend_from_slice(&unit.to_le_bytes());
        }
        let returned = buffer.len() as u32;
        assert_eq!(
            command_line(&buffer, returned).as_deref(),
            Some("git.exe status")
        );
        // A length past what the kernel returned is a torn read.
        assert_eq!(command_line(&buffer, 4), None);
    }

    #[test]
    fn only_an_absolute_drive_or_unc_path_is_a_working_directory() {
        assert_eq!(
            working_directory_path(r"C:\work\ace\"),
            Some(r"C:\work\ace".to_owned())
        );
        assert_eq!(working_directory_path(r"C:\"), Some(r"C:\".to_owned()));
        assert_eq!(
            working_directory_path(r"\\server\share\ace"),
            Some(r"\\server\share\ace".to_owned())
        );
        assert_eq!(working_directory_path(r"work\ace"), None);
        assert_eq!(working_directory_path(r"C:work"), None);
        assert_eq!(working_directory_path("C:\\a\0b"), None);
    }

    #[test]
    fn a_directory_is_read_only_with_full_access_on_64_bit_processes() {
        assert!(reads_directory(true, "x64", Some(false)));
        assert!(reads_directory(true, "arm64", Some(false)));
        assert!(!reads_directory(false, "x64", Some(false)));
        assert!(!reads_directory(true, "x64", Some(true)));
        assert!(!reads_directory(true, "x64", None));
        assert!(!reads_directory(true, "ia32", Some(false)));
    }
}
