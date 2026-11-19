//! Metadata calls never continue in the caller: copy arguments, pin, authorize, perform.
use super::metadata_access::Grants;
use super::supervise::Caller;
use libseccomp::ScmpNotifReq;
use rustix::fs::{AtFlags, Mode, OFlags, Timespec, Timestamps};
use rustix::io::Errno;
use std::ffi::OsString;
use std::fs::File;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::FileExt;
use std::path::Path;

pub const CALLS: &[&str] = &[
    "chmod",
    "fchmod",
    "fchmodat",
    "fchmodat2",
    "chown",
    "fchown",
    "lchown",
    "fchownat",
    "setxattr",
    "lsetxattr",
    "fsetxattr",
    "removexattr",
    "lremovexattr",
    "fremovexattr",
    "utime",
    "utimes",
    "futimesat",
    "utimensat",
];

fn bytes(memory: &File, address: u64, length: usize) -> Result<Vec<u8>, Errno> {
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
fn string(memory: &File, address: u64, limit: usize) -> Result<OsString, Errno> {
    let mut out = vec![0; limit];
    let n = memory
        .read_at(&mut out, address)
        .map_err(|_| Errno::FAULT)?;
    let end = out[..n]
        .iter()
        .position(|b| *b == 0)
        .ok_or(Errno::NAMETOOLONG)?;
    out.truncate(end);
    Ok(OsString::from_vec(out))
}
fn times(memory: &File, address: u64, name: &str) -> Result<Timestamps, Errno> {
    let mut ts = [Timespec {
        tv_sec: 0,
        tv_nsec: 1_073_741_823,
    }; 2];
    if address != 0 {
        let values = bytes(memory, address, if name == "utime" { 16 } else { 32 })?;
        for (i, t) in ts.iter_mut().enumerate() {
            let offset = if name == "utime" { i * 8 } else { i * 16 };
            t.tv_sec = i64::from_ne_bytes(
                values[offset..offset + 8]
                    .try_into()
                    .map_err(|_| Errno::INVAL)?,
            );
            t.tv_nsec = if name == "utime" {
                0
            } else {
                let sub = i64::from_ne_bytes(
                    values[offset + 8..offset + 16]
                        .try_into()
                        .map_err(|_| Errno::INVAL)?,
                );
                if name == "utimensat" {
                    sub
                } else {
                    if !(0..1_000_000).contains(&sub) {
                        return Err(Errno::INVAL);
                    }
                    sub * 1000
                }
            };
        }
    }
    Ok(Timestamps {
        last_access: ts[0],
        last_modification: ts[1],
    })
}

pub fn handle(
    listener: i32,
    request: &ScmpNotifReq,
    name: &str,
    grants: &Grants,
) -> Result<(), Errno> {
    let (caller, memory) = Caller::open(listener, request)?;
    let memory = memory.ok_or(Errno::PERM)?;
    let a = request.data.args;
    // Linux's fd, uid, gid, mode and flags arguments use their low 32 bits.
    let fd_target = matches!(name, "fchmod" | "fchown" | "fsetxattr" | "fremovexattr");
    let at = matches!(
        name,
        "fchmodat" | "fchmodat2" | "fchownat" | "futimesat" | "utimensat"
    );
    let address = if at { a[1] } else { a[0] };
    let flags = match name {
        "fchmodat2" => a[3],
        "fchownat" => a[4],
        "utimensat" => a[3],
        _ => 0,
    } as u32;
    if flags & !(0x100 | 0x1000) != 0 {
        return Err(Errno::INVAL);
    }
    let target = if fd_target || (at && address == 0) {
        grants.fd(caller.duplicate(a[0])?)?
    } else {
        let path = string(&memory, address, 4096)?;
        let path = Path::new(&path);
        let base = if path.is_absolute() {
            rustix::fs::open(
                "/",
                OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC,
                Mode::empty(),
            )?
        } else if at && a[0] as u32 as i32 != -100 {
            caller.duplicate(a[0])?
        } else {
            caller.directory()?
        };
        if path.as_os_str().is_empty() && flags & 0x1000 == 0 {
            return Err(Errno::NOENT);
        }
        grants.path(base, path)?
    };
    let link = rustix::fs::FileType::from_raw_mode(rustix::fs::fstat(&target)?.st_mode)
        == rustix::fs::FileType::Symlink;
    if link
        && !(name == "lchown"
            || (name == "fchownat" && flags & 0x100 != 0)
            || (name == "utimensat" && flags & 0x100 != 0))
    {
        return Err(Errno::PERM);
    }
    let object = format!("/proc/self/fd/{}", target.as_raw_fd());
    super::supervise::valid(listener, request.id)?;
    match name {
        "chmod" | "fchmod" | "fchmodat" | "fchmodat2" => rustix::fs::chmod(
            object,
            Mode::from_bits_truncate(a[if at { 2 } else { 1 }] as u32),
        ),
        "chown" | "lchown" | "fchown" | "fchownat" => {
            let index = if at { 2 } else { 1 };
            let uid = a[index] as u32;
            let gid = a[index + 1] as u32;
            let uid = (uid != u32::MAX).then(|| rustix::process::Uid::from_raw(uid));
            let gid = (gid != u32::MAX).then(|| rustix::process::Gid::from_raw(gid));
            rustix::fs::chownat(
                &target,
                "",
                uid,
                gid,
                AtFlags::EMPTY_PATH | AtFlags::SYMLINK_NOFOLLOW,
            )
        }
        "utime" | "utimes" | "futimesat" | "utimensat" => {
            let t = times(&memory, a[if at { 2 } else { 1 }], name)?;
            rustix::fs::utimensat(
                &target,
                "",
                &t,
                AtFlags::EMPTY_PATH | AtFlags::SYMLINK_NOFOLLOW,
            )
        }
        "setxattr" | "lsetxattr" | "fsetxattr" => {
            let attribute = string(&memory, a[1], 256)?;
            let len = usize::try_from(a[3]).map_err(|_| Errno::TOOBIG)?;
            if len > 65536 {
                return Err(Errno::TOOBIG);
            }
            let value = bytes(&memory, a[2], len)?;
            let flags = rustix::fs::XattrFlags::from_bits(a[4] as u32).ok_or(Errno::INVAL)?;
            rustix::fs::setxattr(object, attribute, &value, flags)
        }
        "removexattr" | "lremovexattr" | "fremovexattr" => {
            rustix::fs::removexattr(object, string(&memory, a[1], 256)?)
        }
        _ => Err(Errno::PERM),
    }
}
