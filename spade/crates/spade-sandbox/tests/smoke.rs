//! Explicit release smoke: real developer tools and real downloads through Spade's proxy.
#![cfg(all(target_os = "linux", feature = "landlock"))]
mod linux;
use spade_sandbox::egress::{EgressLog, NetworkPolicy, Proxy, SystemResolver};
use std::sync::Arc;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires git, cargo, npm, python3-venv, make, cc and network access"]
async fn developer_tooling_works_through_the_contained_proxy() {
    let w = linux::world();
    let logdir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let proxy = Proxy::start(
        Arc::new(EgressLog::new(logdir.path().to_owned())),
        Arc::new(SystemResolver),
        Arc::new(|| 1_700_000_000_000),
        Arc::new(|| "smoke-ticket".to_owned()),
    )
    .await
    .unwrap_or_else(|e| panic!("{e}"));
    let ticket = proxy.open("smoke", "developer-tools", NetworkPolicy::default());
    let policy = linux::policy(&w, Some(proxy.port()));
    let source = r#"set -eu
export CARGO_HOME="$PWD/.cargo" RUSTUP_HOME=/usr/local/rustup
export CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse CARGO_NET_GIT_FETCH_WITH_CLI=true
export HOME="$PWD"
git -c http.proxy="$HTTPS_PROXY" clone --depth 1 https://github.com/octocat/Hello-World.git cloned
test -s cloned/README
echo smoke:git
mkdir -p rust/src
printf '[package]\nname="smoke"\nversion="0.1.0"\nedition="2024"\n[dependencies]\nitoa="1"\n' > rust/Cargo.toml
cat > rust/src/main.rs <<'RUST'
fn main(){println!("{}",itoa::Buffer::new().format(42));}
#[test] fn formats(){assert_eq!(itoa::Buffer::new().format(42),"42");}
RUST
cargo build --manifest-path rust/Cargo.toml
test "$(rust/target/debug/smoke)" = 42
echo smoke:cargo-build
mkdir nodeapp
printf '{"private":true,"dependencies":{"is-number":"7.0.0"}}' > nodeapp/package.json
(cd nodeapp && npm install --ignore-scripts --no-audit --no-fund && node -e 'if(!require("is-number")(42))process.exit(1)')
echo smoke:npm
python3 -m venv venv
venv/bin/python -c 'import sys; assert sys.prefix!=sys.base_prefix'
echo smoke:venv
printf '#include <stdio.h>\nint main(void){puts("made");return 0;}\n' > hello.c
printf 'hello: hello.c\n\t$(CC) -o hello hello.c\n' > Makefile
make
test "$(./hello)" = made
echo smoke:make
cargo test --offline --manifest-path rust/Cargo.toml
echo smoke:test
"#;
    let script = w.workspace.join("smoke.sh");
    std::fs::write(&script, source).unwrap_or_else(|e| panic!("{e}"));
    let launch = linux::runner()
        .wrap(
            &policy,
            std::path::Path::new("/bin/sh"),
            &[script.into_os_string()],
        )
        .unwrap_or_else(|e| panic!("{e}"));
    let env = ticket.env();
    let workspace = w.workspace.clone();
    let temp = policy.temp.clone();
    let output = tokio::task::spawn_blocking(move || {
        let mut command = if let Ok(traces) = std::env::var("SPADE_SMOKE_TRACE") {
            std::fs::create_dir_all(&traces).unwrap_or_else(|e| panic!("{e}"));
            let mut c = std::process::Command::new("strace");
            c.args(["-ff", "-s", "128", "-o"])
                .arg(std::path::Path::new(&traces).join("syscalls"))
                .arg(launch.program);
            c
        } else {
            std::process::Command::new(launch.program)
        };
        command
            .args(launch.args)
            .env_clear()
            .envs(env)
            .env("PATH", "/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin")
            .env("TMPDIR", temp)
            .current_dir(workspace)
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap_or_else(|e| panic!("{e}"))
    })
    .await
    .unwrap_or_else(|e| panic!("{e}"));
    println!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.status.success(),
        "developer smoke failed: {}",
        output.status
    );
    let text = String::from_utf8_lossy(&output.stdout);
    for step in ["git", "cargo-build", "npm", "venv", "make", "test"] {
        assert!(text.contains(&format!("smoke:{step}")), "missing {step}");
    }
    assert!(
        ticket.usage().connections >= 3,
        "downloads did not pass through the proxy"
    );
}
