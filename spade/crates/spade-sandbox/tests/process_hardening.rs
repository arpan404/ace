//! Process identity and lifecycle at the real Linux sandbox boundary.
#![cfg(all(target_os = "linux", feature = "landlock"))]
mod linux;

#[test]
fn the_command_and_namespace_init_have_their_own_sessions() {
    let w = linux::world();
    let abi = linux::runner().status().landlock_abi.unwrap_or(0);
    let init = if abi < 6 {
        "assert os.getsid(1)==1 and os.getpgid(1)==1;"
    } else {
        ""
    };
    let code = format!(
        "import os; {init} assert os.getsid(0)==os.getpid(); assert os.getpgrp()==os.getpid()"
    );
    let launch = linux::runner()
        .wrap(
            &linux::policy(&w, None),
            std::path::Path::new("/usr/bin/python3"),
            &["-c".into(), code.into()],
        )
        .unwrap_or_else(|e| panic!("{e}"));
    let out = std::process::Command::new(launch.program)
        .args(launch.args)
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
fn sched_setattr_cannot_change_the_supervisor_or_an_outside_process() {
    let w = linux::world();
    let p = linux::policy(&w, None);
    let call = |pid| {
        format!(
            "python3 -c 'import ctypes,os,struct; c=ctypes.CDLL(None,use_errno=True); a=ctypes.create_string_buffer(struct.pack(\"=IIQiIQQQ\",48,0,0,0,0,0,0,0)); r=c.syscall(274 if os.uname().machine==\"aarch64\" else 314,{pid},a,0); print(r,ctypes.get_errno())'"
        )
    };
    assert_eq!(
        linux::unconfined(&w.root, &call(std::process::id()))
            .1
            .trim(),
        "0 0"
    );
    let target = if linux::runner().status().landlock_abi.is_some_and(|a| a < 6) {
        1
    } else {
        std::process::id()
    };
    assert_eq!(linux::ok(&p, &call(target)).trim(), "-1 1");
    assert_eq!(linux::ok(&p, &call(0)).trim(), "0 0");
}

#[test]
fn a_nonleader_thread_can_target_itself() {
    let w = linux::world();
    let script = r#"python3 -c 'import ctypes,os,threading,struct
c=ctypes.CDLL(None,use_errno=True); results=[]
def work():
 tid=threading.get_native_id(); assert tid!=os.getpid()
 a=ctypes.create_string_buffer(struct.pack("=IIQiIQQQ",48,0,0,0,0,0,0,0))
 for op in ["c.sched_setparam(tid,ctypes.byref(ctypes.c_int(0)))", "c.sched_setscheduler(tid,0,ctypes.byref(ctypes.c_int(0)))", "c.syscall(274 if os.uname().machine==\"aarch64\" else 314,tid,a,0)", "c.setpriority(0,tid,0)", "c.syscall(30 if os.uname().machine==\"aarch64\" else 251,1,tid,0)", "c.prlimit64(tid,7,None,ctypes.byref((ctypes.c_ulonglong*2)()))"]:
  ctypes.set_errno(0); r=eval(op); results.append((op,r,ctypes.get_errno()))
 try:
  os.sched_setaffinity(tid,os.sched_getaffinity(0)); results.append(("affinity",0,0))
 except OSError as e: results.append(("affinity",-1,e.errno))
t=threading.Thread(target=work); t.start(); t.join(); assert len(results)==7 and all(r==0 for _,r,_ in results), results
'"#;
    assert_eq!(linux::unconfined(&w.root, script).0, 0);
    linux::ok(&linux::policy(&w, None), script);
}

#[test]
fn pidfd_open_distinguishes_processes_threads_zero_and_unknown_flags() {
    let w = linux::world();
    let script = r#"python3 -c 'import ctypes,os,threading,errno
c=ctypes.CDLL(None,use_errno=True); results=[]
def opened(pid,flags):
 ctypes.set_errno(0); fd=c.pidfd_open(pid,flags); error=ctypes.get_errno()
 if fd>=0: os.close(fd)
 return fd,error
def work():
 tid=threading.get_native_id()
 for flags in [0,2048]: results.append(opened(os.getpid(),flags)[0]>=0)
 fd,error=opened(tid,128); results.append(fd>=0 or error==errno.EINVAL)
 results.append(opened(tid,0)==(-1,errno.EPERM))
 results.append(opened(0,0)==(-1,errno.EPERM))
 results.append(opened(os.getpid(),0x80000000)==(-1,errno.EPERM))
t=threading.Thread(target=work); t.start(); t.join(); assert results==[True]*6, results
'"#;
    linux::ok(&linux::policy(&w, None), script);
}

fn until(mut ready: impl FnMut() -> bool, duration: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + duration;
    while std::time::Instant::now() < deadline {
        if ready() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    ready()
}

fn stop_tree(root_ignores: bool, pressure: bool) {
    use std::time::Duration;
    let w = linux::world();
    let p = linux::policy(&w, None);
    let source = r#"import os,signal,subprocess,sys,time
signal.signal(signal.SIGTERM,signal.SIG_IGN)
end=time.monotonic()+8
if len(sys.argv)>1:
    open("child-ready","w").close()
    while time.monotonic()<end and not os.path.exists("stop-fixture"):
        with open("pulse","ab",buffering=0) as f: f.write(b"x")
        time.sleep(0.02)
else:
    child=subprocess.Popen([sys.executable,__file__,"child"],start_new_session=True)
    while time.monotonic()<end and not os.path.exists("child-ready"): time.sleep(0.005)
    open("ready","w").close()
    while time.monotonic()<end and not os.path.exists("stop-fixture"): time.sleep(0.02)
    child.wait()
"#;
    let handler = if root_ignores {
        "signal.signal(signal.SIGTERM,signal.SIG_IGN)"
    } else {
        "def term(sig,frame):\n open(\"term-received\",\"w\").close(); raise SystemExit(0)\nsignal.signal(signal.SIGTERM,term)"
    };
    let mut source = source.replacen("signal.signal(signal.SIGTERM,signal.SIG_IGN)", handler, 1);
    if pressure {
        source = source.replace("    open(\"ready\",\"w\").close()", "    import socket\n    for i in range(100):\n        try:\n            s=socket.socket(); s.bind((\"127.0.0.1\",0)); s.close()\n        except OSError: pass\n    open(\"ready\",\"w\").close()");
    }
    let script = w.workspace.join("tree.py");
    std::fs::write(&script, source).unwrap_or_else(|e| panic!("{e}"));
    let launch = linux::runner()
        .wrap(
            &p,
            std::path::Path::new("/usr/bin/python3"),
            &[script.into_os_string()],
        )
        .unwrap_or_else(|e| panic!("{e}"));
    let mut command = if pressure {
        let mut command = std::process::Command::new("/usr/bin/python3");
        command.args(["-c", "import os,resource,sys; resource.setrlimit(resource.RLIMIT_NOFILE,(64,64)); os.execv(sys.argv[1],sys.argv[1:])"]);
        command.arg(launch.program);
        command
    } else {
        std::process::Command::new(launch.program)
    };
    let mut child = command
        .args(launch.args)
        .current_dir(&w.workspace)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap_or_else(|e| panic!("{e}"));
    let ready = until(
        || w.workspace.join("ready").exists(),
        Duration::from_secs(3),
    );
    let _ = rustix::process::kill_process(
        rustix::process::Pid::from_child(&child),
        rustix::process::Signal::TERM,
    );
    let stopped = until(
        || child.try_wait().is_ok_and(|s| s.is_some()),
        Duration::from_secs(2),
    );
    let before = std::fs::metadata(w.workspace.join("pulse"))
        .map(|m| m.len())
        .unwrap_or(0);
    std::thread::sleep(Duration::from_millis(150));
    let after = std::fs::metadata(w.workspace.join("pulse"))
        .map(|m| m.len())
        .unwrap_or(0);
    // Cleanup is independent of the behaviour being tested, including on the red run.
    let _ = std::fs::write(w.workspace.join("stop-fixture"), "");
    std::thread::sleep(Duration::from_millis(60));
    if !stopped {
        let _ = child.kill();
    }
    let _ = child.wait();
    assert!(ready, "the fixture did not start");
    if !root_ignores {
        assert!(
            w.workspace.join("term-received").exists(),
            "SIGTERM never reached the command"
        );
    }
    assert!(stopped, "SIGTERM never ended the outer launcher");
    assert_eq!(
        before, after,
        "a detached descendant kept running after the launcher exited"
    );
}

#[test]
fn process_mrelease_is_refused_before_resolving_an_fd_target() {
    let w = linux::world();
    let script = "python3 -c 'import ctypes; c=ctypes.CDLL(None,use_errno=True); r=c.syscall(448,-1,0); print(r,ctypes.get_errno())'";
    assert_eq!(linux::unconfined(&w.root, script).1.trim(), "-1 9");
    assert_eq!(linux::ok(&linux::policy(&w, None), script).trim(), "-1 1");
}

#[test]
fn stopping_the_outer_launcher_ends_even_detached_signal_ignoring_descendants() {
    stop_tree(true, false);
}

#[test]
fn sigterm_reaches_the_command_before_its_detached_descendants_are_stopped() {
    stop_tree(false, false);
}

#[test]
fn stopping_a_run_still_works_after_socket_descriptor_pressure() {
    stop_tree(true, true);
}

#[test]
fn accepting_the_callers_tid_does_not_allow_a_sibling_tid() {
    let w = linux::world();
    let script = r#"python3 -c 'import ctypes,threading
hold=threading.Event(); t=threading.Thread(target=lambda:hold.wait()); t.start()
c=ctypes.CDLL(None,use_errno=True); r=c.sched_setparam(t.native_id,ctypes.byref(ctypes.c_int(0))); print(r,ctypes.get_errno()); hold.set(); t.join()
'"#;
    assert_eq!(linux::unconfined(&w.root, script).1.trim(), "0 0");
    assert_eq!(linux::ok(&linux::policy(&w, None), script).trim(), "-1 1");
}

#[test]
fn a_terminal_interrupt_is_forwarded_to_the_commands_process_group() {
    use std::time::Duration;
    let w = linux::world();
    let script = w.workspace.join("interrupt.py");
    std::fs::write(
        &script,
        r#"import signal,subprocess,time
child=subprocess.Popen(["/bin/sleep","8"])
def interrupt(sig,frame):
    assert child.wait(timeout=1)==-signal.SIGINT
    open("interrupted","w").close()
    raise SystemExit(0)
signal.signal(signal.SIGINT,interrupt)
open("ready","w").close()
time.sleep(8)
"#,
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let launch = linux::runner()
        .wrap(
            &linux::policy(&w, None),
            std::path::Path::new("/usr/bin/python3"),
            &[script.into_os_string()],
        )
        .unwrap_or_else(|e| panic!("{e}"));
    let mut child = std::process::Command::new(launch.program)
        .args(launch.args)
        .current_dir(&w.workspace)
        .stdin(std::process::Stdio::null())
        .spawn()
        .unwrap_or_else(|e| panic!("{e}"));
    let ready = until(
        || w.workspace.join("ready").exists(),
        Duration::from_secs(3),
    );
    let pid = rustix::process::Pid::from_child(&child);
    let _ = rustix::process::kill_process(pid, rustix::process::Signal::INT);
    let done = until(
        || child.try_wait().is_ok_and(|s| s.is_some()),
        Duration::from_secs(2),
    );
    if !done {
        let _ = rustix::process::kill_process(pid, rustix::process::Signal::TERM);
        if !until(
            || child.try_wait().is_ok_and(|s| s.is_some()),
            Duration::from_secs(1),
        ) {
            let _ = child.kill();
        }
    }
    let _ = child.wait();
    assert!(
        ready && done && w.workspace.join("interrupted").exists(),
        "SIGINT did not reach the command and its child"
    );
}

#[test]
fn a_long_workspace_tmpdir_does_not_break_the_namespace_handshake() {
    let mut w = linux::world();
    w.workspace = w.workspace.join("a".repeat(160));
    std::fs::create_dir_all(w.workspace.join(".spade/tmp")).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(linux::ok(&linux::policy(&w, None), "printf ready"), "ready");
}
