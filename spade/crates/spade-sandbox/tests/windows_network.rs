//! Measuring the routes for giving a networked Windows run egress while it stays a Less Privileged
//! AppContainer (ADR 0167, Windows amendment). Ignored by default: it changes machine settings for
//! a moment (a registry ACE, firewall rules, a loopback exemption, all taken back at the end) and
//! reaches real registries, so it runs only on the test VM, explicitly:
//! `cargo test -p spade-sandbox --test windows_network -- --ignored --nocapture --test-threads=1`.
//!
//! It prints one line per route: whether Winsock starts, which tools work through the proxy, and
//! what else the run can reach. The tools live in `C:\ace\nettools`, readable through the test
//! capability `spadeTestTools` (granted once by the VM's setup, not by Spade).
#![cfg(windows)]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use spade_sandbox::egress::{EgressLog, Mode, NetworkPolicy, Proxy, SystemResolver};
use spade_sandbox::windows::Container;
use spade_sandbox_windows::acl::{self, Access};
use spade_sandbox_windows::fs::Object;
use spade_sandbox_windows::job::Limits;
use spade_sandbox_windows::launch::{self, Token};
use spade_sandbox_windows::profile;
use spade_sandbox_windows::sid::Sid;

const TOOLS: &str = r"C:\ace\nettools";

/// The Winsock catalog keys, granted read to a Spade capability by route (a2).
const WINSOCK_KEYS: [&str; 1] = [r"HKLM:\SYSTEM\CurrentControlSet\Services\WinSock2\Parameters"];

/// Registry keys asked about, to see what a route opens beyond Winsock.
const REGISTRY: [&str; 5] = [
    r"HKLM\SYSTEM\CurrentControlSet\Services\WinSock2\Parameters",
    r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion",
    r"HKLM\SYSTEM\CurrentControlSet\Control\ComputerName\ComputerName",
    r"HKLM\SOFTWARE\Microsoft\Cryptography",
    r"HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters",
];

/// Hosts the tools need, allowed through the proxy.
const HOSTS: [&str; 7] = [
    "registry.npmjs.org",
    "github.com",
    "pypi.org",
    "files.pythonhosted.org",
    "crates.io",
    "index.crates.io",
    "static.crates.io",
];

struct Profile(Container);
impl Drop for Profile {
    fn drop(&mut self) {
        let _ = profile::delete(&self.0.name);
    }
}

fn helper() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_scw_helper"))
}

fn limits() -> Limits {
    Limits {
        active_processes: 64,
        memory_bytes: 4 * 1024 * 1024 * 1024,
    }
}

fn grant(path: &Path, sid: &Sid, access: Access) {
    let object = Object::open(path).unwrap_or_else(|e| panic!("open {}: {e}", path.display()));
    acl::grant(&object, sid, access).unwrap_or_else(|e| panic!("grant {}: {e}", path.display()));
}

fn free_port() -> u16 {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or_else(|_| std::process::abort())
}

fn powershell(script: &str) -> String {
    let out = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .unwrap_or_else(|_| std::process::abort());
    format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

/// What one route is: its token, and the machine settings it needs around the runs.
struct Route {
    name: &'static str,
    token_caps: Vec<&'static str>,
    lpac: bool,
    /// Grant read on the Winsock catalog to this route's own capability.
    winsock_grant: bool,
    /// Firewall rules for the run's package plus a loopback exemption, and tools pointed straight
    /// at the proxy instead of the in-container bridge.
    firewall: bool,
}

fn routes() -> Vec<Route> {
    vec![
        Route {
            name: "lpac",
            token_caps: vec![],
            lpac: true,
            winsock_grant: false,
            firewall: false,
        },
        Route {
            name: "(a1) lpac+registryRead",
            token_caps: vec!["registryRead"],
            lpac: true,
            winsock_grant: false,
            firewall: false,
        },
        Route {
            name: "(a2) lpac+winsock-only",
            token_caps: vec!["spadeWinsockTest"],
            lpac: true,
            winsock_grant: true,
            firewall: false,
        },
        Route {
            name: "(b0) lpac+internetClient",
            token_caps: vec!["internetClient"],
            lpac: true,
            winsock_grant: false,
            firewall: false,
        },
        Route {
            name: "(b1) lpac+registryRead+internetClient",
            token_caps: vec!["registryRead", "internetClient"],
            lpac: true,
            winsock_grant: false,
            firewall: false,
        },
        Route {
            name: "(b2) lpac+registryRead+internetClient+firewall",
            token_caps: vec!["registryRead", "internetClient"],
            lpac: true,
            winsock_grant: false,
            firewall: true,
        },
        Route {
            name: "plain",
            token_caps: vec![],
            lpac: false,
            winsock_grant: false,
            firewall: false,
        },
    ]
}

/// The tools' command lines, each run through `cmd.exe` with the proxy and a writable home.
fn tools(ws: &Path) -> Vec<(&'static str, String)> {
    let ws = ws.display();
    vec![
        (
            "curl",
            r"%SystemRoot%\System32\curl.exe -sS --fail -o NUL --max-time 60 https://registry.npmjs.org/left-pad".to_owned(),
        ),
        (
            "git",
            format!(r"{TOOLS}\git\cmd\git.exe ls-remote https://github.com/octocat/Hello-World.git HEAD"),
        ),
        (
            "npm",
            format!(
                r"{TOOLS}\node\node.exe {TOOLS}\node\node_modules\npm\bin\npm-cli.js view left-pad version"
            ),
        ),
        (
            "pip",
            format!(r"{TOOLS}\python\python.exe {TOOLS}\pip.pyz download six --no-deps -d {ws}\dl"),
        ),
        ("cargo", format!(r"{TOOLS}\cargo.exe search serde --limit 1")),
    ]
}

fn with_env(ws: &Path, proxy: &str, command: &str) -> String {
    let ws = ws.display();
    let mut line = String::new();
    for (name, value) in [
        ("HOME", format!("{ws}")),
        ("USERPROFILE", format!("{ws}")),
        ("APPDATA", format!(r"{ws}\appdata")),
        ("LOCALAPPDATA", format!(r"{ws}\local")),
        ("TEMP", format!(r"{ws}\tmp")),
        ("TMP", format!(r"{ws}\tmp")),
        ("HTTP_PROXY", proxy.to_owned()),
        ("HTTPS_PROXY", proxy.to_owned()),
        ("http_proxy", proxy.to_owned()),
        ("https_proxy", proxy.to_owned()),
        ("npm_config_proxy", proxy.to_owned()),
        ("npm_config_https_proxy", proxy.to_owned()),
        ("npm_config_cache", format!(r"{ws}\npm")),
        ("CARGO_HOME", format!(r"{ws}\cargo")),
        ("PIP_CACHE_DIR", format!(r"{ws}\pipcache")),
        ("GIT_CONFIG_NOSYSTEM", "1".to_owned()),
    ] {
        line.push_str(&format!("set {name}={value}&& "));
    }
    line.push_str(command);
    line
}

fn cmd() -> String {
    format!(
        r"{}\System32\cmd.exe",
        std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_owned())
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "changes machine settings and reaches real registries; run on the test VM"]
async fn measure_the_routes_for_networked_runs() {
    assert!(
        Path::new(TOOLS).join("node").exists(),
        "the VM's tools aren't set up"
    );
    let tools_cap = Sid::capability("spadeTestTools").unwrap_or_else(|_| std::process::abort());
    let winsock_cap = Sid::capability("spadeWinsockTest").unwrap_or_else(|_| std::process::abort());

    // An outside listener on another loopback port, a file only every app package may read.
    let other =
        std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap_or_else(|_| std::process::abort());
    let other_port = other.local_addr().map(|a| a.port()).unwrap_or(0);
    let aap_dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    let aap_file = aap_dir.path().join("aap.txt");
    std::fs::write(&aap_file, b"x").unwrap_or_else(|_| std::process::abort());
    let aap = Sid::parse("S-1-15-2-1").unwrap_or_else(|_| std::process::abort());
    for path in [aap_dir.path(), aap_file.as_path()] {
        grant(path, &aap, Access::Read);
    }

    let log_dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    let proxy = Proxy::start(
        Arc::new(EgressLog::new(log_dir.path().to_path_buf())),
        Arc::new(SystemResolver),
        Arc::new(|| 0),
        Arc::new(|| uuid::Uuid::new_v4().simple().to_string()),
    )
    .await
    .unwrap_or_else(|_| std::process::abort());

    for route in routes() {
        let name = format!("spade.net.{}", uuid::Uuid::new_v4().simple());
        let container = Container {
            name: name.clone(),
            display: "Spade network probe".to_owned(),
        };
        let _profile = Profile(container.clone());
        let sid =
            profile::ensure(&name, &container.display).unwrap_or_else(|_| std::process::abort());
        let mut caps: Vec<Sid> = route
            .token_caps
            .iter()
            .map(|n| Sid::capability(n).unwrap_or_else(|_| std::process::abort()))
            .collect();
        caps.push(tools_cap.clone());
        let token = Token {
            lpac: route.lpac,
            capabilities: caps,
        };

        let ws_dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let ws = ws_dir.path().to_path_buf();
        for sub in ["tmp", "appdata", "local", "dl", "npm", "cargo", "pipcache"] {
            std::fs::create_dir_all(ws.join(sub)).unwrap_or_else(|_| std::process::abort());
        }
        grant(&ws, &sid, Access::Write);
        grant(
            helper().parent().unwrap_or_else(|| std::process::abort()),
            &sid,
            Access::Read,
        );

        // Route settings, taken back below.
        if route.winsock_grant {
            for key in WINSOCK_KEYS {
                powershell(&format!(
                    "$a=Get-Acl '{key}'; $r=New-Object System.Security.AccessControl.RegistryAccessRule((New-Object System.Security.Principal.SecurityIdentifier('{winsock_cap}')),'ReadKey','ContainerInherit','None','Allow'); $a.AddAccessRule($r); Set-Acl '{key}' $a"
                ));
            }
        }
        let proxy_port = proxy.port();
        if route.firewall {
            let lo = format!("1-{},{}-65535", proxy_port - 1, proxy_port + 1);
            powershell(&format!(
                "New-NetFirewallRule -DisplayName 'spade-net-test-{name}-a' -Direction Outbound -Action Block -Package '{sid}' -Protocol TCP -RemoteAddress 127.0.0.0/8 -RemotePort {lo} | Out-Null; \
                 New-NetFirewallRule -DisplayName 'spade-net-test-{name}-b' -Direction Outbound -Action Block -Package '{sid}' -Protocol TCP -RemoteAddress 0.0.0.0-126.255.255.255,128.0.0.0-255.255.255.255,::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff | Out-Null; \
                 New-NetFirewallRule -DisplayName 'spade-net-test-{name}-c' -Direction Outbound -Action Block -Package '{sid}' -Protocol UDP | Out-Null; \
                 CheckNetIsolation.exe LoopbackExempt -a -p={sid} | Out-Null"
            ));
        }

        let run = |args: &[&str], bridge: Option<launch::Bridge>| -> u32 {
            let args: Vec<OsString> = args.iter().map(OsString::from).collect();
            let (program, args): (OsString, Vec<OsString>) = (helper().into_os_string(), args);
            launch::run_in(
                &token,
                &container.name,
                &container.display,
                limits(),
                bridge,
                Some(&helper()),
                &program,
                &args,
            )
            .unwrap_or(9999)
        };
        let probes = [
            ("winsock", run(&["winsock"], None)),
            ("dns", run(&["resolve", "example.com"], None)),
            ("tcp-direct", run(&["tcp", "1.1.1.1:443"], None)),
            ("udp-dns", run(&["udp-dns", "1.1.1.1"], None)),
            (
                "other-loopback",
                run(&["tcp", &format!("127.0.0.1:{other_port}")], None),
            ),
            (
                "aap-file",
                run(&["read", &aap_file.to_string_lossy()], None),
            ),
        ];

        // Each registry key through reg.exe, in the same token.
        let mut registry = Vec::new();
        for key in REGISTRY {
            let code = launch::run_in(
                &token,
                &container.name,
                &container.display,
                limits(),
                None,
                None,
                std::ffi::OsStr::new(&cmd()),
                &[
                    OsString::from("/c"),
                    OsString::from(format!("reg query \"{key}\" >nul 2>nul")),
                ],
            )
            .unwrap_or(9999);
            registry.push((key.rsplit('\\').next().unwrap_or(key).to_owned(), code));
        }

        // The tools through the proxy: by the in-container bridge, or straight at the proxy where
        // the route exempts loopback.
        let mut results = Vec::new();
        for (tool, command) in tools(&ws) {
            let policy = NetworkPolicy {
                mode: Mode::AllowList,
                allow: HOSTS.iter().map(|h| (*h).to_owned()).collect(),
                dropped: Vec::new(),
            };
            let ticket = proxy.open(&container.name, tool, policy);
            let (bridge, url, stop) = if route.firewall {
                (None, ticket.url_on(proxy_port), None)
            } else {
                let pipe = format!("spade-net-{}", uuid::Uuid::new_v4().simple());
                let stop = spade_sandbox::windows::bridge::Stop::new();
                let (ready, ready_rx) = std::sync::mpsc::sync_channel(1);
                {
                    let (p, s, st) = (pipe.clone(), sid.clone(), stop.clone());
                    tokio::spawn(async move {
                        spade_sandbox::windows::bridge::serve(&p, &s, proxy_port, &st, ready).await;
                    });
                }
                let _ = ready_rx.recv_timeout(std::time::Duration::from_secs(5));
                let port = free_port();
                (
                    Some(launch::Bridge { pipe, port }),
                    ticket.url_on(port),
                    Some(stop),
                )
            };
            let line = with_env(&ws, &url, &command);
            let (t, c, d) = (token.clone(), container.clone(), cmd());
            let code = tokio::task::spawn_blocking(move || {
                launch::run_in(
                    &t,
                    &c.name,
                    &c.display,
                    limits(),
                    bridge,
                    Some(&helper()),
                    std::ffi::OsStr::new(&d),
                    &[OsString::from("/c"), OsString::from(line)],
                )
                .unwrap_or(9999)
            })
            .await
            .unwrap_or(9999);
            if let Some(stop) = stop {
                stop.stop();
            }
            results.push((tool, code));
            drop(ticket);
        }

        println!(
            "ROUTE {} | probes {:?} | registry {:?} | tools {:?}",
            route.name, probes, registry, results
        );

        if route.winsock_grant {
            for key in WINSOCK_KEYS {
                powershell(&format!(
                    "$a=Get-Acl '{key}'; $a.Access | Where-Object {{ $_.IdentityReference.Value -eq '{winsock_cap}' -or $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq '{winsock_cap}' }} | ForEach-Object {{ [void]$a.RemoveAccessRule($_) }}; Set-Acl '{key}' $a"
                ));
            }
        }
        if route.firewall {
            powershell(&format!(
                "Get-NetFirewallRule -DisplayName 'spade-net-test-{name}-*' | Remove-NetFirewallRule; CheckNetIsolation.exe LoopbackExempt -d -p={sid} | Out-Null"
            ));
        }
    }
    drop(other);
}

/// The tools as program and arguments, verbose, for the diagnosis.
fn verbose_tools(ws: &Path) -> Vec<(&'static str, String, Vec<String>)> {
    let sys = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_owned());
    let dl = ws.join("dl").display().to_string();
    vec![
        (
            "curl",
            format!(r"{sys}\System32\curl.exe"),
            vec![
                "-v".into(),
                "--fail".into(),
                "-o".into(),
                "NUL".into(),
                "--max-time".into(),
                "60".into(),
                "https://registry.npmjs.org/left-pad".into(),
            ],
        ),
        (
            "git",
            format!(r"{TOOLS}\git\cmd\git.exe"),
            vec![
                "ls-remote".into(),
                "https://github.com/octocat/Hello-World.git".into(),
                "HEAD".into(),
            ],
        ),
        (
            "npm",
            format!(r"{TOOLS}\node\node.exe"),
            vec![
                format!(r"{TOOLS}\node\node_modules\npm\bin\npm-cli.js"),
                "view".into(),
                "left-pad".into(),
                "version".into(),
                "--loglevel".into(),
                "verbose".into(),
            ],
        ),
        (
            "pip",
            format!(r"{TOOLS}\python\python.exe"),
            vec![
                format!(r"{TOOLS}\pip.pyz"),
                "download".into(),
                "six".into(),
                "--no-deps".into(),
                "-v".into(),
                "-d".into(),
                dl,
            ],
        ),
        (
            "cargo",
            format!(r"{TOOLS}\cargo.exe"),
            vec![
                "search".into(),
                "serde".into(),
                "--limit".into(),
                "1".into(),
                "-v".into(),
            ],
        ),
    ]
}

/// The environment a tool gets: a writable home and temp in the run's workspace, the proxy in
/// every spelling the tools read, and their verbose switches.
fn env_lines(ws: &Path, proxy: &str) -> String {
    let w = ws.display();
    [
        format!("HOME={w}"),
        format!("USERPROFILE={w}"),
        format!(r"APPDATA={w}\appdata"),
        format!(r"LOCALAPPDATA={w}\local"),
        format!(r"TEMP={w}\tmp"),
        format!(r"TMP={w}\tmp"),
        format!("HTTP_PROXY={proxy}"),
        format!("HTTPS_PROXY={proxy}"),
        format!("ALL_PROXY={proxy}"),
        format!("http_proxy={proxy}"),
        format!("https_proxy={proxy}"),
        format!("all_proxy={proxy}"),
        format!("npm_config_proxy={proxy}"),
        format!("npm_config_https_proxy={proxy}"),
        format!(r"npm_config_cache={w}\npm"),
        format!("PIP_PROXY={proxy}"),
        format!(r"PIP_CACHE_DIR={w}\pipcache"),
        format!(r"CARGO_HOME={w}\cargo"),
        format!("CARGO_HTTP_PROXY={proxy}"),
        "CARGO_HTTP_DEBUG=true".to_owned(),
        "GIT_CONFIG_NOSYSTEM=1".to_owned(),
        format!("GIT_CONFIG_COUNT=1\nGIT_CONFIG_KEY_0=http.proxy\nGIT_CONFIG_VALUE_0={proxy}"),
        "GIT_TRACE=1".to_owned(),
        "GIT_CURL_VERBOSE=1".to_owned(),
    ]
    .join("\n")
}

/// Each tool run verbosely through the proxy and bridge, under LPAC + `registryRead` and a plain
/// token for comparison (the control: networked runs work there today): its own output, why a
/// loopback listener can or can't be made in the token, and what the proxy logged.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "reaches real registries; run on the test VM"]
async fn diagnose_the_tools_through_the_proxy() {
    let tools_cap = Sid::capability("spadeTestTools").unwrap_or_else(|_| std::process::abort());
    let read_cap = Sid::capability("registryRead").unwrap_or_else(|_| std::process::abort());
    let log_dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
    let log = Arc::new(EgressLog::new(log_dir.path().to_path_buf()));
    let proxy = Proxy::start(
        log.clone(),
        Arc::new(SystemResolver),
        Arc::new(|| 0),
        Arc::new(|| uuid::Uuid::new_v4().simple().to_string()),
    )
    .await
    .unwrap_or_else(|_| std::process::abort());
    for (label, lpac, caps) in [
        ("plain", false, vec![tools_cap.clone()]),
        (
            "lpac+registryRead",
            true,
            vec![read_cap.clone(), tools_cap.clone()],
        ),
    ] {
        let name = format!("spade.diag.{}", uuid::Uuid::new_v4().simple());
        let container = Container {
            name: name.clone(),
            display: "Spade network diagnosis".to_owned(),
        };
        let _profile = Profile(container.clone());
        let sid =
            profile::ensure(&name, &container.display).unwrap_or_else(|_| std::process::abort());
        let token = Token {
            lpac,
            capabilities: caps,
        };
        let ws_dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let ws = ws_dir.path().to_path_buf();
        for sub in ["tmp", "appdata", "local", "dl", "npm", "cargo", "pipcache"] {
            std::fs::create_dir_all(ws.join(sub)).unwrap_or_else(|_| std::process::abort());
        }
        grant(&ws, &sid, Access::Write);
        grant(
            helper().parent().unwrap_or_else(|| std::process::abort()),
            &sid,
            Access::Read,
        );

        // Can this token make a loopback listener at all, and if not, why?
        let why = ws.join("bind.txt");
        let bind = launch::run_in(
            &token,
            &name,
            &container.display,
            limits(),
            None,
            None,
            helper().as_os_str(),
            &[OsString::from("bind-why"), why.clone().into_os_string()],
        )
        .unwrap_or(9999);
        println!(
            "=== {label} bind -> {bind}: {}",
            std::fs::read_to_string(&why).unwrap_or_default()
        );

        for (tool, program, args) in verbose_tools(&ws) {
            let policy = NetworkPolicy {
                mode: Mode::AllowList,
                allow: HOSTS.iter().map(|h| (*h).to_owned()).collect(),
                dropped: Vec::new(),
            };
            let bot = format!("{name}-{tool}");
            let ticket = proxy.open(&bot, tool, policy);
            let pipe = format!("spade-diag-{}", uuid::Uuid::new_v4().simple());
            let stop = spade_sandbox::windows::bridge::Stop::new();
            let (ready, ready_rx) = std::sync::mpsc::sync_channel(1);
            {
                let (p, s, st, port) = (pipe.clone(), sid.clone(), stop.clone(), proxy.port());
                tokio::spawn(async move {
                    spade_sandbox::windows::bridge::serve(&p, &s, port, &st, ready).await;
                });
            }
            let _ = ready_rx.recv_timeout(std::time::Duration::from_secs(5));
            let port = free_port();
            let env = ws.join(format!("{tool}.env"));
            std::fs::write(&env, env_lines(&ws, &ticket.url_on(port)))
                .unwrap_or_else(|_| std::process::abort());
            let out = ws.join(format!("{tool}.log"));
            let mut all: Vec<OsString> = vec![
                "run-env".into(),
                env.into_os_string(),
                out.clone().into_os_string(),
                program.into(),
            ];
            all.extend(args.into_iter().map(OsString::from));
            let (t, c) = (token.clone(), container.clone());
            let bridge = launch::Bridge { pipe, port };
            let code = tokio::task::spawn_blocking(move || {
                launch::run_in(
                    &t,
                    &c.name,
                    &c.display,
                    limits(),
                    Some(bridge),
                    Some(&helper()),
                    helper().as_os_str(),
                    &all,
                )
                .map_err(|e| e.to_string())
            })
            .await
            .unwrap_or_else(|_| Err("join".to_owned()));
            stop.stop();
            let text =
                std::fs::read_to_string(&out).unwrap_or_else(|e| format!("(no output: {e})"));
            let tail: Vec<&str> = text.lines().rev().take(12).collect();
            let proxied: Vec<String> = log.read(&bot, 5).iter().map(|e| format!("{e:?}")).collect();
            println!("=== {label} {tool} -> {code:?}\n--- proxy log: {proxied:?}");
            for l in tail.into_iter().rev() {
                println!("    {}", l.chars().take(220).collect::<String>());
            }
            drop(ticket);
        }
    }
}
