//! What a command sees of the machine's other processes, on this machine's kernel (ADR 0167
//! amendment 1, decision 9).
#![cfg(all(target_os = "linux", feature = "landlock"))]
mod linux;

use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use spade_sandbox::linux::{Network, Processes, plan};

/// A process outside the sandbox whose command line carries `marker`, readable from outside.
struct Outside(Child);

impl Outside {
    fn start(marker: &str) -> Self {
        let child = Command::new("python3")
            .args(["-c", "import time; time.sleep(30)", marker])
            .stdin(Stdio::null())
            .spawn()
            .unwrap_or_else(|e| panic!("{e}"));
        let outside = Self(child);
        let path = format!("/proc/{}/cmdline", outside.pid());
        let deadline = Instant::now() + Duration::from_secs(5);
        while !std::fs::read(&path).is_ok_and(|line| contains(&line, marker)) {
            assert!(
                Instant::now() < deadline,
                "the outside process didn't start"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        outside
    }

    fn pid(&self) -> u32 {
        self.0.id()
    }
}

impl Drop for Outside {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn contains(bytes: &[u8], marker: &str) -> bool {
    String::from_utf8_lossy(bytes).contains(marker)
}

fn marker() -> String {
    format!("spade-marker-{}", uuid::Uuid::new_v4().simple())
}

/// Reads the outside process's command line, by its number and by listing `/proc`.
fn reads(pid: u32) -> String {
    format!("cat /proc/{pid}/cmdline; cat /proc/[0-9]*/cmdline; true")
}

#[test]
fn another_processs_command_line_cant_be_read_in_the_commands_own_namespace() {
    assert!(
        linux::namespaced(),
        "this machine allows user namespaces, so commands get their own"
    );
    let w = linux::world();
    let p = linux::policy(&w, None);
    let marker = marker();
    let outside = Outside::start(&marker);
    let seen = linux::ok(&p, &reads(outside.pid()));
    assert!(!seen.contains(&marker), "{seen}");
    // Its own processes, and only those, are there to read.
    let own = linux::ok(
        &p,
        "cat /proc/self/status >/dev/null && ls /proc | grep -c '^[0-9][0-9]*$'",
    );
    let listed: u32 = own.trim().parse().unwrap_or_else(|e| panic!("{own}: {e}"));
    assert!((1..10).contains(&listed), "{own}");
}

#[test]
fn without_a_namespace_no_process_folder_can_be_read_not_even_its_own() {
    let w = linux::world();
    let marker = marker();
    let outside = Outside::start(&marker);
    let hidden = plan(
        &linux::policy(&w, None),
        Network::Filtered,
        Processes::Hidden,
    );
    let run = |script: &str| {
        let out = linux::launched(&hidden, "/bin/sh", &["-c", script])
            .output()
            .unwrap_or_else(|e| panic!("{e}"));
        (
            out.status.code(),
            format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            ),
        )
    };
    let (code, seen) = run(&reads(outside.pid()));
    assert_eq!(code, Some(0), "{seen}");
    assert!(!seen.contains(&marker), "{seen}");
    // It shares the host's process numbers, so even its own folder stays closed.
    assert_ne!(run("cat /proc/self/status").0, Some(0));
    // The machine-wide entries stay readable for tools that size themselves.
    let (code, cpus) = run("grep -c ^processor /proc/cpuinfo");
    assert_eq!(code, Some(0), "{cpus}");
}
