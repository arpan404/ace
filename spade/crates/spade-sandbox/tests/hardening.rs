//! Linux boundary regressions using harmless queries and no-op updates.
#![cfg(all(target_os = "linux", feature = "landlock"))]
mod linux;
use linux::{ok, policy, refused, unconfined, world};
fn python(code: &str) -> String {
    format!("python3 -c '{code}'")
}

#[test]
fn disconnecting_a_bound_socket_is_refused_even_through_a_shared_descriptor() {
    let w = world();
    let p = policy(&w, None);
    let script = python(
        "import socket,ctypes,os; c=ctypes.CDLL(None,use_errno=True); s=socket.socket(); s.bind((\"127.0.0.1\",0)); fd=os.dup(s.fileno()); a=ctypes.create_string_buffer(16); r=c.connect(fd,a,16); print(r,ctypes.get_errno())",
    );
    assert_eq!(unconfined(&w.root, &script).1.trim(), "0 0");
    assert_eq!(ok(&p, &script).trim(), "-1 1");
}

#[test]
fn concurrent_disconnect_and_listen_never_open_a_wildcard_listener() {
    let w = world();
    ok(&policy(&w,None), &python("import socket,ctypes,threading,os; c=ctypes.CDLL(None,use_errno=True)
for i in range(100):
 s=socket.socket(); s.bind((\"127.0.0.1\",0)); fd=os.dup(s.fileno()); a=ctypes.create_string_buffer(16); results=[]
 def disconnect():
  r=c.connect(fd,a,16); results.append((r,ctypes.get_errno()))
 t=threading.Thread(target=disconnect); t.start(); s.listen(); t.join(); assert results==[(-1,1)]; assert s.getsockname()[0]==\"127.0.0.1\"; os.close(fd); s.close()"));
}

#[test]
fn pid_operations_allow_self_but_refuse_an_outside_process() {
    let w = world();
    let p = policy(&w, None);
    let victim = std::process::id();
    for operation in [
        "c.prlimit64(pid,7,None,ctypes.byref((ctypes.c_ulonglong*2)()))",
        "c.sched_setparam(pid,ctypes.byref(ctypes.c_int(0)))",
        "c.sched_setscheduler(pid,0,ctypes.byref(ctypes.c_int(0)))",
        "c.setpriority(0,pid,0)",
        "c.syscall(30 if os.uname().machine==\"aarch64\" else 251,1,pid,0)",
        "c.pidfd_open(pid,0)",
    ] {
        let script = |target: &str| {
            python(&format!(
                "import ctypes,os; c=ctypes.CDLL(None,use_errno=True); pid={target}; r={operation}; print(int(r>=0),ctypes.get_errno())"
            ))
        };
        let outside = script(&victim.to_string());
        assert_eq!(unconfined(&w.root, &outside).1.trim(), "1 0", "{operation}");
        assert_eq!(ok(&p, &outside).trim(), "0 1", "{operation}");
        for target in ["0", "os.getpid()"] {
            if target == "0" && operation.contains("pidfd_open") {
                continue;
            }
            assert_eq!(
                ok(&p, &script(target)).trim(),
                "1 0",
                "{operation} {target}"
            );
        }
    }
    let affinity = |pid| {
        python(&format!(
            "import os; os.sched_setaffinity({pid},os.sched_getaffinity(0))"
        ))
    };
    assert_eq!(unconfined(&w.root, &affinity(victim)).0, 0);
    refused(&p, &affinity(victim));
    ok(&p, &affinity(0));
}

#[test]
fn signals_reach_children_and_self_but_not_an_outside_process() {
    let w = world();
    let p = policy(&w, None);
    let script = python(&format!("import os; os.kill({},0)", std::process::id()));
    assert_eq!(unconfined(&w.root, &script).0, 0);
    refused(&p, &script);
    ok(
        &p,
        &python(
            "import os,subprocess,signal; os.kill(os.getpid(),0); p=subprocess.Popen([\"sleep\",\"30\"]); os.kill(p.pid,signal.SIGTERM); assert p.wait()==-signal.SIGTERM",
        ),
    );
}

#[test]
fn an_inherited_loopback_bind_does_not_grant_permission_to_listen() {
    use std::ffi::OsString;
    use std::path::Path;
    let w = world();
    let p = policy(&w, None);
    let launch = linux::runner()
        .wrap(
            &p,
            Path::new("/usr/bin/python3"),
            &[
                OsString::from("-c"),
                OsString::from("import socket; socket.socket(fileno=TESTFD).listen()"),
            ],
        )
        .unwrap_or_else(|e| panic!("{e}"));
    let argv: Vec<String> = std::iter::once(launch.program.to_string_lossy().into_owned())
        .chain(launch.args.iter().map(|a| a.to_string_lossy().into_owned()))
        .collect();
    let json = serde_json::to_string(&argv).unwrap_or_default();
    let code = format!(
        "import socket,subprocess,json; s=socket.socket(); s.bind((\"127.0.0.1\",0)); args=json.loads({}); args=[a.replace(\"TESTFD\",str(s.fileno())) for a in args]; r=subprocess.run(args,pass_fds=(s.fileno(),)); assert r.returncode!=0",
        serde_json::to_string(&json).unwrap_or_default()
    );
    // Use Command directly: the JSON contains single quotes in some valid paths.
    let out = std::process::Command::new("python3")
        .args(["-c", &code])
        .current_dir(&w.workspace)
        .output()
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}
