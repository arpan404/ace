//! Device, metadata and IPC boundaries against real Linux objects.
#![cfg(all(target_os = "linux", feature = "landlock"))]
mod linux;

#[test]
fn only_the_inherited_pty_can_be_opened_not_another_same_user_terminal() {
    let w = linux::world();
    let code = r#"import errno,os,sys
try:
 f=os.open(sys.argv[1],os.O_RDWR|os.O_NOCTTY); os.close(f)
except OSError as e:
 assert sys.argv[2]=="denied" and e.errno in (errno.EACCES,errno.EPERM),e
else:
 assert sys.argv[2]=="allowed","opened another terminal"
"#;
    let launch = linux::runner()
        .wrap(
            &linux::policy(&w, None),
            std::path::Path::new("/usr/bin/python3"),
            &["-c".into(), code.into(), "TARGET_PTY".into(), "MODE".into()],
        )
        .unwrap_or_else(|e| panic!("{e}"));
    let args: Vec<String> = std::iter::once(launch.program.to_string_lossy().into_owned())
        .chain(launch.args.iter().map(|a| a.to_string_lossy().into_owned()))
        .collect();
    let json = serde_json::to_string(&serde_json::to_string(&args).unwrap_or_default())
        .unwrap_or_default();
    let parent = format!(
        r#"import json,os,pty,subprocess
m,s=pty.openpty(); path=os.ttyname(s); assert os.stat(path).st_uid==os.getuid()
args=json.loads({json})
for mode,stdin in [("denied",subprocess.DEVNULL),("allowed",s)]:
 a=[v.replace("TARGET_PTY",path).replace("MODE",mode) for v in args]
 r=subprocess.run(a,stdin=stdin); assert r.returncode==0
os.close(m); os.close(s)
"#
    );
    let out = std::process::Command::new("python3")
        .args(["-c", &parent])
        .current_dir(&w.workspace)
        .output()
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn file_metadata_changes_require_a_write_grant_for_paths_and_fds() {
    let w = linux::world();
    let p = linux::policy(&w, None);
    let outside = w.home.join("notes/todo.md");
    let inside = w.workspace.join("metadata");
    std::fs::write(&inside, "content").unwrap_or_else(|e| panic!("{e}"));
    for operation in [
        "os.chmod(path,0o600)",
        "os.chmod(os.path.basename(path),0o600,dir_fd=os.open(os.path.dirname(path),os.O_RDONLY))",
        "r=c.syscall(452,-100,os.fsencode(path),0o600,0); check(r)",
        "r=c.utime(os.fsencode(path),None); check(r)",
        "r=c.utimes(os.fsencode(path),None); check(r)",
        "r=c.futimesat(-100,os.fsencode(path),None); check(r)",
        "os.chown(path,os.getuid(),os.getgid(),follow_symlinks=False)",
        "os.fchmod(os.open(path,os.O_RDONLY),0o600)",
        "os.chown(path,os.getuid(),os.getgid())",
        "os.fchown(os.open(path,os.O_RDONLY),os.getuid(),os.getgid())",
        "os.utime(path,ns=(1_000_000_000,2_000_000_000))",
        "os.utime(os.open(path,os.O_RDONLY),ns=(1_000_000_000,2_000_000_000))",
        "os.setxattr(path,\"user.spade\",b\"v\")",
        "os.setxattr(os.open(path,os.O_RDONLY),\"user.spade\",b\"v\")",
        "os.removexattr(path,\"user.spade\")",
        "os.removexattr(os.open(path,os.O_RDONLY),\"user.spade\")",
    ] {
        let code = |path: &std::path::Path| {
            format!(
                "python3 -c 'import os,errno,ctypes; c=ctypes.CDLL(None,use_errno=True); path={}\ndef check(r):\n if r<0: raise OSError(ctypes.get_errno(),\"metadata\")\ntry: {operation}\nexcept OSError as e: print(e.errno)\nelse: print(0)'",
                serde_json::to_string(&path.to_string_lossy()).unwrap_or_default()
            )
        };
        let seed = || {
            let script = format!(
                "python3 -c 'import os; os.setxattr({},\"user.spade\",b\"seed\"); os.setxattr({},\"user.spade\",b\"seed\")'",
                serde_json::to_string(&outside.to_string_lossy()).unwrap_or_default(),
                serde_json::to_string(&inside.to_string_lossy()).unwrap_or_default()
            );
            assert_eq!(linux::unconfined(&w.root, &script).0, 0);
        };
        seed();
        assert_eq!(
            linux::unconfined(&w.root, &code(&outside)).1.trim(),
            "0",
            "{operation}"
        );
        seed();
        let denied = linux::ok(&p, &code(&outside));
        assert!(matches!(denied.trim(), "1" | "13"), "{operation}: {denied}");
        assert_eq!(linux::ok(&p, &code(&inside)).trim(), "0", "{operation}");
    }
}

#[test]
fn unlisted_syscalls_are_refused_instead_of_inheriting_default_allow() {
    let w = linux::world();
    let call = "python3 -c 'import ctypes; c=ctypes.CDLL(None,use_errno=True); r=c.personality(ctypes.c_ulong(0xffffffff)); print(r,ctypes.get_errno())'";
    assert!(linux::unconfined(&w.root, call).1.trim().ends_with(" 0"));
    assert_eq!(linux::ok(&linux::policy(&w, None), call).trim(), "-1 1");
}

#[test]
fn fcntl_cannot_install_signal_owners_on_descriptors() {
    let w = linux::world();
    let code = "python3 -c 'import os,fcntl; r,w=os.pipe()\ntry: fcntl.fcntl(w,fcntl.F_SETOWN,os.getpid())\nexcept OSError as e: print(e.errno)\nelse: print(0)'";
    assert_eq!(linux::unconfined(&w.root, code).1.trim(), "0");
    assert_eq!(linux::ok(&linux::policy(&w, None), code).trim(), "1");
}

#[test]
fn system_v_ipc_creates_no_host_objects() {
    let w = linux::world();
    let p = linux::policy(&w, None);
    for (create, remove) in [
        ("c.shmget(0,4096,0o600)", "c.shmctl(r,0,None)"),
        ("c.msgget(0,0o600)", "c.msgctl(r,0,None)"),
        ("c.semget(0,1,0o600)", "c.semctl(r,0,0)"),
    ] {
        let code = format!(
            "python3 -c 'import ctypes; c=ctypes.CDLL(None,use_errno=True); r={create}; error=ctypes.get_errno()\nif r>=0: {remove}\nprint(int(r>=0),error)'"
        );
        assert_eq!(linux::unconfined(&w.root, &code).1.trim(), "1 0");
        assert_eq!(linux::ok(&p, &code).trim(), "0 1");
    }
}

#[test]
fn private_shm_and_a_metadata_symlink_race_cannot_touch_host_objects() {
    let w = linux::world();
    let p = linux::policy(&w, None);
    let shm = std::path::Path::new("/dev/shm").join(format!("spade-test-{}", uuid::Uuid::new_v4()));
    std::fs::write(&shm, "private").unwrap_or_else(|e| panic!("{e}"));
    let result = linux::run(&p, &format!("cat {}", linux::quoted(&shm)));
    let _ = std::fs::remove_file(shm);
    assert_ne!(result.0, 0, "host POSIX shm was readable");
    let outside = w.home.join("notes/todo.md");
    let target = serde_json::to_string(&outside.to_string_lossy()).unwrap_or_default();
    linux::ok(
        &p,
        &format!(
            r#"python3 -c 'import os,threading
outside={target}; before=os.stat(outside).st_mode
open("victim","w").close(); os.chmod("victim",0o600)
def race():
 for i in range(150):
  os.symlink(outside,"next-link");os.replace("next-link","victim")
  open("next-file","w").close();os.replace("next-file","victim")
t=threading.Thread(target=race);t.start()
for i in range(150):
 try:os.chmod("victim",0o600)
 except OSError:pass
t.join();assert os.stat(outside).st_mode==before,"outside mode changed through a link"
'"#
        ),
    );
}

#[test]
fn nofollow_metadata_changes_the_owned_link_not_its_read_only_target() {
    let w = linux::world();
    let p = linux::policy(&w, None);
    let outside =
        serde_json::to_string(&w.home.join("notes/todo.md").to_string_lossy()).unwrap_or_default();
    linux::ok(
        &p,
        &format!(
            r#"python3 -c 'import os,socket
outside={outside}; before=os.stat(outside).st_mtime_ns
os.symlink(outside,"link")
os.utime("link",ns=(1,1),follow_symlinks=False)
assert os.lstat("link").st_mtime_ns==1 and os.stat(outside).st_mtime_ns==before
os.chown("link",os.getuid(),os.getgid(),follow_symlinks=False)
s=socket.socket(socket.AF_UNIX); s.bind("owned.sock");os.chmod("owned.sock",0o600)
assert os.stat("owned.sock").st_mode & 0o777==0o600
'"#
        ),
    );
}
