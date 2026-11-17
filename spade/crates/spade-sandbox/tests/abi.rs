//! A real compatibility ABI call must not bypass the native allowlist.
#![cfg(all(target_os = "linux", target_arch = "x86_64", feature = "landlock"))]
mod linux;
use std::os::unix::process::ExitStatusExt;
#[test]
fn an_i386_getpid_call_is_killed_even_though_native_getpid_is_allowed() {
    let w = linux::world();
    let source = w.workspace.join("compat.c");
    let program = w.workspace.join("compat");
    std::fs::write(&source,"int main(void){long pid; __asm__ volatile(\"int $0x80\":\"=a\"(pid):\"0\"(20):\"memory\");return pid>0?0:1;}\n").unwrap_or_else(|e|panic!("{e}"));
    let built = std::process::Command::new("cc")
        .arg(&source)
        .arg("-o")
        .arg(&program)
        .output()
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(
        built.status.success(),
        "{}",
        String::from_utf8_lossy(&built.stderr)
    );
    assert!(
        std::process::Command::new(&program)
            .status()
            .is_ok_and(|s| s.success())
    );
    let launch = linux::runner()
        .wrap(&linux::policy(&w, None), &program, &[])
        .unwrap_or_else(|e| panic!("{e}"));
    let out = std::process::Command::new(launch.program)
        .args(launch.args)
        .output()
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        out.status.signal(),
        Some(31),
        "compatibility call bypassed the native filter"
    );
}
