//! Bounded shutdown under a real per-process fd limit and detached descendants.
#![cfg(all(target_os = "linux", feature = "landlock"))]
mod linux;
use std::time::{Duration, Instant};
fn until(mut f: impl FnMut() -> bool, seconds: u64) -> bool {
    let end = Instant::now() + Duration::from_secs(seconds);
    while Instant::now() < end {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    f()
}

fn scenario(exhaust: bool) {
    let w = linux::world();
    let script = w.workspace.join("many.py");
    std::fs::write(
        &script,
        r#"import os,signal,time
signal.signal(signal.SIGTERM,signal.SIG_IGN)
end=time.monotonic()+30
gate_r,gate_w=os.pipe()
for i in range(160):
 if os.fork()==0:
  os.close(gate_w)
  os.setsid()
  os.read(gate_r,1); os.close(gate_r)
  while time.monotonic()<end and not os.path.exists("fixture-stop"):
   with open("pulse","ab",buffering=0) as f:f.write(b"x")
   time.sleep(0.02)
  os._exit(0)
os.close(gate_r); os.close(gate_w)
open("ready","w").close()
while time.monotonic()<end and not os.path.exists("fixture-stop"): time.sleep(0.02)
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
    let mut child=std::process::Command::new("/usr/bin/python3").args(["-c","import os,resource,sys;resource.setrlimit(resource.RLIMIT_NOFILE,(64,64));os.execv(sys.argv[1],sys.argv[1:])"]).arg(launch.program).args(launch.args).current_dir(&w.workspace).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap_or_else(|e|panic!("{e}"));
    let ready = until(
        || {
            w.workspace.join("ready").exists()
                && std::fs::metadata(w.workspace.join("pulse")).is_ok_and(|m| m.len() > 0)
        },
        12,
    );
    if exhaust {
        let mut target = child.id();
        if linux::namespaced() {
            // Outer launcher -> unshare -> namespace init. Fault the actual reaper, not
            // the host-side waiter, while the fixture keeps every process alive.
            for _ in 0..2 {
                let children =
                    std::fs::read_to_string(format!("/proc/{target}/task/{target}/children"))
                        .unwrap_or_else(|e| panic!("{e}"));
                target = children
                    .split_whitespace()
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or_else(|| panic!("missing namespace child"));
            }
        }
        let descriptors = std::fs::read_dir(format!("/proc/{target}/fd"))
            .unwrap_or_else(|e| panic!("{e}"))
            .count();
        let limit = u64::try_from(descriptors.saturating_sub(2)).unwrap_or(0);
        rustix::process::prlimit(
            Some(
                rustix::process::Pid::from_raw(i32::try_from(target).unwrap_or(0))
                    .unwrap_or_else(|| panic!("invalid target")),
            ),
            rustix::process::Resource::Nofile,
            rustix::process::Rlimit {
                current: Some(limit),
                maximum: Some(limit),
            },
        )
        .unwrap_or_else(|e| panic!("{e}"));
    }
    let _ = rustix::process::kill_process(
        rustix::process::Pid::from_child(&child),
        rustix::process::Signal::TERM,
    );
    let ended = until(|| child.try_wait().is_ok_and(|s| s.is_some()), 4);
    let before = std::fs::metadata(w.workspace.join("pulse"))
        .map(|m| m.len())
        .unwrap_or(0);
    std::thread::sleep(Duration::from_millis(150));
    let after = std::fs::metadata(w.workspace.join("pulse"))
        .map(|m| m.len())
        .unwrap_or(0);
    let _ = std::fs::write(w.workspace.join("fixture-stop"), "");
    std::thread::sleep(Duration::from_millis(80));
    if !ended {
        let _ = child.kill();
    }
    let _ = child.wait();
    assert!(ready, "fixture did not start");
    assert!(ended, "cleanup blocked after an incomplete fd sweep");
    assert_eq!(before, after, "detached children survived shutdown");
}

#[test]
fn low_fd_shutdown_reaps_many_detached_children_without_a_blocking_wait() {
    scenario(false);
}
#[test]
fn emfile_during_shutdown_uses_identity_checked_fallback_without_leaking_children() {
    scenario(true);
}
