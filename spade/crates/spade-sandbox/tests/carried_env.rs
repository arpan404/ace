//! A run's environment is carried past Spade's own launcher (ADR 0171, amendment 4), in the real
//! Linux sandbox: a plugin's entry can name `LD_PRELOAD`, and the launcher starts outside the
//! sandbox, so started with that environment as it is, the loader would run the library there,
//! unconfined. Carried (`run_env::sealed`), the launcher never sees the name; the command inside
//! gets the environment as it was, where the library runs confined.
#![cfg(all(target_os = "linux", feature = "landlock"))]
mod linux;

use std::ffi::OsString;
use std::path::Path;
use std::process::{Command, Stdio};

/// A library whose constructor writes `<path>` wherever it is loaded.
fn library(dir: &Path, path: &Path) -> std::path::PathBuf {
    let source = dir.join("inject.c");
    std::fs::write(
        &source,
        format!(
            "#include <stdio.h>\n\
             __attribute__((constructor)) static void run(void) {{\n\
               FILE *f = fopen(\"{}\", \"w\"); if (f) {{ fputs(\"ran\", f); fclose(f); }}\n\
             }}\n",
            path.display()
        ),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let library = dir.join("inject.so");
    let built = Command::new("cc")
        .args(["-shared", "-fPIC", "-o"])
        .arg(&library)
        .arg(&source)
        .status()
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(built.success());
    library
}

/// Starts `launch` with `env` exactly, from the workspace; what it printed.
fn started(
    launch: &spade_sandbox::Launch,
    workspace: &Path,
    env: Vec<(OsString, OsString)>,
) -> String {
    let out = Command::new(&launch.program)
        .args(&launch.args)
        .current_dir(workspace)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .output()
        .unwrap_or_else(|e| panic!("{e}"));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[test]
fn a_preload_a_plugin_names_never_runs_in_the_launcher_outside_the_sandbox() {
    let world = linux::world();
    let escaped = world.root.join("escaped");
    // In the workspace, so the command inside can load it too (and is held there).
    let library = library(&world.workspace, &escaped);
    let launch = linux::runner()
        .wrap(
            &linux::policy(&world, None),
            Path::new("/bin/sh"),
            &[OsString::from("-c"), OsString::from("echo \"$API_TOKEN\"")],
        )
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(launch.seals_env, "the launcher is Spade's own");
    let run_env: Vec<(OsString, OsString)> = vec![
        ("PATH".into(), "/usr/bin:/bin".into()),
        ("HOME".into(), world.workspace.clone().into()),
        ("API_TOKEN".into(), "t0k".into()),
        ("LD_PRELOAD".into(), library.clone().into()),
    ];
    // The premise: started with that environment as it is, the launcher runs the library
    // outside the sandbox.
    started(&launch, &world.workspace, run_env.clone());
    assert!(
        escaped.exists(),
        "the loader should run a preload in the launcher"
    );
    std::fs::remove_file(&escaped).unwrap_or_else(|e| panic!("{e}"));
    // Carried, as Spade starts it: the command still gets its environment, and the library
    // runs only inside the sandbox, where it can't write outside.
    let said = started(
        &launch,
        &world.workspace,
        spade_sandbox::run_env::sealed(run_env).unwrap_or_else(|e| panic!("{e}")),
    );
    assert_eq!(said.trim(), "t0k");
    assert!(!escaped.exists(), "the preload ran outside the sandbox");
}
