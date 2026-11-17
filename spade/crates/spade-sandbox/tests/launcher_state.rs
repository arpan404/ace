//! The launcher and its namespace init run unrestricted, so none of their own state may live at a
//! pathname a contained process can write: a link planted there would point their writes outside.
#![cfg(all(target_os = "linux", feature = "landlock"))]
mod linux;

use std::process::Stdio;
use std::time::{Duration, Instant};

#[test]
fn a_link_planted_where_launcher_state_could_live_changes_nothing_outside() {
    let w = linux::world();
    let p = linux::policy(&w, None);
    let victim = w.root.join("victim.txt");
    let target = serde_json::to_string(&victim.to_string_lossy()).unwrap_or_default();
    // A contained process that, while other runs start, turns every new entry in their temporary
    // folder and workspace into a link to a file outside the sandbox, as fast as it can.
    let planter = format!(
        r#"python3 -c 'import os,time
victim={target}; folders=[os.environ["TMPDIR"],"."]
open("planting","w").close(); end=time.time()+60
while time.time()<end and not os.path.exists("stop"):
 for folder in folders:
  for name in os.listdir(folder):
   path=os.path.join(folder,name)
   if name in ("planting","stop",".spade") or name.endswith(".link") or os.path.islink(path):
    continue
   try:
    os.symlink(victim,path+".link"); os.replace(path+".link",path)
   except OSError:
    pass
'"#
    );
    let launch = linux::runner()
        .wrap(
            &p,
            std::path::Path::new("/bin/sh"),
            &["-c".into(), planter.into()],
        )
        .unwrap_or_else(|e| panic!("{e}"));
    let mut planting = std::process::Command::new(&launch.program)
        .args(&launch.args)
        .current_dir(&p.workspace)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("TMPDIR", &p.temp)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap_or_else(|e| panic!("{e}"));
    let deadline = Instant::now() + Duration::from_secs(10);
    while !p.workspace.join("planting").exists() {
        assert!(Instant::now() < deadline, "the planter didn't start");
        std::thread::sleep(Duration::from_millis(10));
    }
    // Runs that end by a signal, the launcher state a namespace init reports at the very end.
    for _ in 0..40 {
        let (code, text) = linux::run(&p, "kill -TERM $$");
        assert_ne!(code, 0, "{text}");
    }
    std::fs::write(p.workspace.join("stop"), "").unwrap_or_else(|e| panic!("{e}"));
    let _ = planting.wait();
    assert_eq!(
        std::fs::read_to_string(&victim).unwrap_or_default(),
        "victim",
        "a launcher wrote through a link planted by a contained process"
    );
}
