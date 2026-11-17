//! Terminal changes (modes and window size) never continue in the caller: the supervisor copies
//! the new value, takes the caller's descriptor, and makes the change itself, only when that
//! descriptor is the command's dedicated pty ([`super::pty`]). Read-only terminal queries are
//! allowed directly on any descriptor ([`super::allowlist::IOCTL`]); a change to any other
//! terminal is refused, so a terminal the command still somehow holds keeps its settings.

use std::fs::File;
use std::os::unix::fs::FileExt;

use libseccomp::ScmpNotifReq;
use rustix::io::Errno;
use rustix::termios::{
    ControlModes, InputModes, LocalModes, OptionalActions, OutputModes, SpecialCodeIndex, Termios,
    Winsize,
};

use super::supervise::Caller;

const TCSETS: u64 = 0x5402;
const TCSETSW: u64 = 0x5403;
const TCSETSF: u64 = 0x5404;
const TIOCSWINSZ: u64 = 0x5414;
const TCSETS2: u64 = 0x402c_542b;
const TCSETSW2: u64 = 0x402c_542c;
const TCSETSF2: u64 = 0x402c_542d;

/// The supervised requests: the same numbers on x86_64 and aarch64.
pub const CHANGES: &[u64] = &[
    TCSETS, TCSETSW, TCSETSF, TCSETS2, TCSETSW2, TCSETSF2, TIOCSWINSZ,
];

/// The kernel's `struct termios` (`TCSETS*`) and `struct termios2` (`TCSETS*2`) sizes.
const TERMIOS: usize = 36;
const TERMIOS2: usize = 44;
/// `c_cc`'s meaningful entries, by their index in it.
const CODES: [SpecialCodeIndex; 17] = [
    SpecialCodeIndex::VINTR,
    SpecialCodeIndex::VQUIT,
    SpecialCodeIndex::VERASE,
    SpecialCodeIndex::VKILL,
    SpecialCodeIndex::VEOF,
    SpecialCodeIndex::VTIME,
    SpecialCodeIndex::VMIN,
    SpecialCodeIndex::VSWTC,
    SpecialCodeIndex::VSTART,
    SpecialCodeIndex::VSTOP,
    SpecialCodeIndex::VSUSP,
    SpecialCodeIndex::VEOL,
    SpecialCodeIndex::VREPRINT,
    SpecialCodeIndex::VDISCARD,
    SpecialCodeIndex::VWERASE,
    SpecialCodeIndex::VLNEXT,
    SpecialCodeIndex::VEOL2,
];

/// The dedicated pty, by the device and inode of its node.
pub type Dedicated = Option<(u64, u64)>;

fn word(bytes: &[u8], at: usize) -> Result<u32, Errno> {
    bytes
        .get(at..at + 4)
        .and_then(|b| b.try_into().ok())
        .map(u32::from_ne_bytes)
        .ok_or(Errno::FAULT)
}

/// `current` with the modes a `TCSETS*` (36 bytes) or `TCSETS*2` (44 bytes) call passed.
/// Pure: the bytes were already copied out of the caller.
pub fn modes(bytes: &[u8], mut current: Termios) -> Result<Termios, Errno> {
    if bytes.len() == TERMIOS2 {
        // As the kernel does: the integer speeds count only where `c_cflag` says BOTHER.
        current.set_input_speed(word(bytes, 36)?)?;
        current.set_output_speed(word(bytes, 40)?)?;
    } else if bytes.len() != TERMIOS {
        return Err(Errno::FAULT);
    }
    current.input_modes = InputModes::from_bits_retain(word(bytes, 0)?);
    current.output_modes = OutputModes::from_bits_retain(word(bytes, 4)?);
    current.control_modes = ControlModes::from_bits_retain(word(bytes, 8)?);
    current.local_modes = LocalModes::from_bits_retain(word(bytes, 12)?);
    current.line_discipline = bytes[16];
    for (index, code) in CODES.iter().enumerate() {
        current.special_codes[*code] = bytes[17 + index];
    }
    Ok(current)
}

/// The window size a `TIOCSWINSZ` call passed.
pub fn size(bytes: &[u8]) -> Result<Winsize, Errno> {
    let half = |at: usize| {
        bytes
            .get(at..at + 2)
            .and_then(|b| b.try_into().ok())
            .map(u16::from_ne_bytes)
            .ok_or(Errno::FAULT)
    };
    Ok(Winsize {
        ws_row: half(0)?,
        ws_col: half(2)?,
        ws_xpixel: half(4)?,
        ws_ypixel: half(6)?,
    })
}

fn copied(memory: &File, address: u64, length: usize) -> Result<Vec<u8>, Errno> {
    let mut out = vec![0; length];
    if memory
        .read_at(&mut out, address)
        .map_err(|_| Errno::FAULT)?
        != length
    {
        return Err(Errno::FAULT);
    }
    Ok(out)
}

/// Answers one supervised terminal change.
pub fn handle(listener: i32, request: &ScmpNotifReq, dedicated: Dedicated) -> Result<(), Errno> {
    let a = request.data.args;
    let call = a[1];
    if !CHANGES.contains(&call) {
        return Err(Errno::PERM);
    }
    let (caller, memory) = Caller::open(listener, request)?;
    // An ioctl's descriptor is an `int`: its low 32 bits.
    let target = caller.duplicate(u64::from(a[0] as u32))?;
    if !rustix::termios::isatty(&target) {
        return Err(Errno::NOTTY);
    }
    let stat = rustix::fs::fstat(&target)?;
    #[allow(clippy::unnecessary_cast)]
    let id = (stat.st_dev as u64, stat.st_ino as u64);
    if dedicated != Some(id) {
        return Err(Errno::PERM);
    }
    let memory = memory.ok_or(Errno::PERM)?;
    if call == TIOCSWINSZ {
        let size = size(&copied(&memory, a[2], 8)?)?;
        super::supervise::valid(listener, request.id)?;
        return rustix::termios::tcsetwinsize(&target, size);
    }
    let (length, action) = match call {
        TCSETS => (TERMIOS, OptionalActions::Now),
        TCSETSW => (TERMIOS, OptionalActions::Drain),
        TCSETSF => (TERMIOS, OptionalActions::Flush),
        TCSETS2 => (TERMIOS2, OptionalActions::Now),
        TCSETSW2 => (TERMIOS2, OptionalActions::Drain),
        _ => (TERMIOS2, OptionalActions::Flush),
    };
    let wanted = modes(
        &copied(&memory, a[2], length)?,
        rustix::termios::tcgetattr(&target)?,
    )?;
    super::supervise::valid(listener, request.id)?;
    rustix::termios::tcsetattr(&target, action, &wanted)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn termios(iflag: u32, lflag: u32, codes: &[(usize, u8)]) -> Vec<u8> {
        let mut bytes = vec![0u8; TERMIOS];
        bytes[0..4].copy_from_slice(&iflag.to_ne_bytes());
        bytes[4..8].copy_from_slice(&5u32.to_ne_bytes());
        bytes[8..12].copy_from_slice(&0o277u32.to_ne_bytes());
        bytes[12..16].copy_from_slice(&lflag.to_ne_bytes());
        for (index, value) in codes {
            bytes[17 + index] = *value;
        }
        bytes
    }

    /// A real terminal's modes to start from: the kernel's own defaults on a fresh pty.
    fn current() -> Termios {
        let flags = rustix::pty::OpenptFlags::RDWR | rustix::pty::OpenptFlags::NOCTTY;
        let master = rustix::pty::openpt(flags).unwrap_or_else(|e| panic!("{e}"));
        rustix::pty::unlockpt(&master).unwrap_or_else(|e| panic!("{e}"));
        let slave =
            rustix::pty::ioctl_tiocgptpeer(&master, flags).unwrap_or_else(|e| panic!("{e}"));
        rustix::termios::tcgetattr(&slave).unwrap_or_else(|e| panic!("{e}"))
    }

    #[test]
    fn a_tcsets_call_sets_exactly_the_modes_and_codes_it_passed() {
        let start = current();
        let changed = modes(&termios(0o2400, 0o12, &[(0, 7), (4, 9), (6, 1)]), start)
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(changed.input_modes.bits(), 0o2400);
        assert_eq!(changed.output_modes.bits(), 5);
        assert_eq!(changed.control_modes.bits(), 0o277);
        assert_eq!(changed.local_modes.bits(), 0o12);
        assert_eq!(changed.special_codes[SpecialCodeIndex::VINTR], 7);
        assert_eq!(changed.special_codes[SpecialCodeIndex::VEOF], 9);
        assert_eq!(changed.special_codes[SpecialCodeIndex::VMIN], 1);
        assert_eq!(changed.special_codes[SpecialCodeIndex::VQUIT], 0);
    }

    #[test]
    fn a_short_or_oversized_value_is_refused_rather_than_guessed() {
        let start = current();
        assert_eq!(modes(&[0u8; 20], start.clone()).err(), Some(Errno::FAULT));
        assert_eq!(modes(&[0u8; 40], start).err(), Some(Errno::FAULT));
        assert_eq!(size(&[1, 0, 2]).err(), Some(Errno::FAULT));
    }

    #[test]
    fn a_window_size_is_read_as_rows_columns_and_pixels() {
        let mut bytes = Vec::new();
        for value in [24u16, 80, 640, 480] {
            bytes.extend_from_slice(&value.to_ne_bytes());
        }
        let size = size(&bytes).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            (size.ws_row, size.ws_col, size.ws_xpixel, size.ws_ypixel),
            (24, 80, 640, 480)
        );
    }
}
