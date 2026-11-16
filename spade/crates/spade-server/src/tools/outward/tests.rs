use std::sync::Mutex;

use serde_json::json;

use super::host::{Host, HostFuture, HostRan, Launch};
use super::{git, github, messages};

/// Stands in for git, gh and osascript: records each launch, answers `remote get-url` with
/// `rewritten` (the person's own URL rewriting), everything else with success.
struct Recorded {
    rewritten: String,
    launches: Mutex<Vec<Launch>>,
}

impl Recorded {
    fn new(rewritten: &str) -> Self {
        Self {
            rewritten: rewritten.to_owned(),
            launches: Mutex::default(),
        }
    }

    fn launches(&self) -> Vec<Launch> {
        self.launches.lock().map(|l| l.clone()).unwrap_or_default()
    }

    fn ran(&self, word: &str) -> bool {
        self.launches()
            .iter()
            .any(|l| l.args.iter().any(|a| a == word))
    }
}

impl Host for Recorded {
    fn run(&self, launch: Launch) -> HostFuture {
        let get_url = launch.args.iter().any(|a| a == "get-url");
        if let Ok(mut launches) = self.launches.lock() {
            launches.push(launch);
        }
        let stdout = if get_url {
            format!("{}\n", self.rewritten)
        } else {
            String::new()
        };
        Box::pin(async move {
            Ok(HostRan {
                code: Some(0),
                stdout,
                stderr: String::new(),
            })
        })
    }
}

/// Stands in for the sandboxed staging: leaves a bundle (or a link, when told) and answers the
/// remote's URL as stored.
struct Staging {
    url: String,
    link: bool,
}

impl git::Stage for Staging {
    fn stage(&self, staging: git::Staging) -> git::StageFuture {
        let (url, link) = (self.url.clone(), self.link);
        Box::pin(async move {
            let bundle = staging.into.join("push.bundle");
            if link {
                std::os::unix::fs::symlink("/etc/hosts", &bundle).map_err(|e| e.to_string())?;
            } else {
                std::fs::write(&bundle, "# v2 git bundle\n").map_err(|e| e.to_string())?;
            }
            Ok(git::Staged { bundle, url })
        })
    }
}

fn stage(url: &str) -> Staging {
    Staging {
        url: url.to_owned(),
        link: false,
    }
}

/// A workspace, and Spade's scratch folder beside it.
fn workspace() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let root = std::fs::canonicalize(dir.path()).unwrap_or_else(|e| panic!("{e}"));
    let workspace = root.join("workspace");
    std::fs::create_dir_all(workspace.join("app")).unwrap_or_else(|e| panic!("{e}"));
    (dir, workspace, root.join("scratch"))
}

fn push_args(repo: &str) -> git::PushArgs {
    serde_json::from_value(json!({"repo": repo, "branch": "spade/fix", "path": "app"}))
        .unwrap_or_else(|e| panic!("{e}"))
}

const URL: &str = "https://github.com/acme/app.git";

#[tokio::test]
async fn a_push_fetches_only_the_staged_bundle_and_pushes_from_a_clean_repository() {
    let (_dir, workspace, scratch) = workspace();
    let host = Recorded::new(URL);
    let out = git::push(
        &host,
        &stage(URL),
        &workspace,
        &scratch,
        push_args("acme/app"),
    )
    .await;
    assert!(!out.is_error, "{}", out.content);
    assert!(
        out.content.contains("github.com/acme/app"),
        "{}",
        out.content
    );
    let launches = host.launches();
    let fetch = launches
        .iter()
        .find(|l| l.args.iter().any(|a| a == "fetch"))
        .map(|l| l.args.clone())
        .unwrap_or_default();
    // From the bundle the sandbox left in Spade's folder, never from the bot's repository.
    assert!(
        fetch.iter().any(|a| a.ends_with("stage/push.bundle")),
        "{fetch:?}"
    );
    let push = launches.last().map(|l| l.args.clone()).unwrap_or_default();
    for word in ["push", "core.hooksPath=/dev/null", "--no-verify", "dest"] {
        assert!(push.contains(&word.to_owned()), "{word}: {push:?}");
    }
    for launch in &launches {
        assert!(launch.dir.starts_with(&scratch), "{launch:?}");
        assert!(
            !launch.args.iter().any(|a| a.contains("workspace")),
            "{launch:?}"
        );
    }
    assert!(!scratch.read_dir().is_ok_and(|mut d| d.next().is_some()));
}

#[tokio::test]
async fn a_push_to_another_host_repository_or_transport_never_starts() {
    let (_dir, workspace, scratch) = workspace();
    // (the URL as stored, where the person's rewriting sends it)
    let cases = [
        ("https://attacker.example/acme/app.git", URL),
        ("https://github.com/someone/else.git", URL),
        ("ext::sh -c 'touch /tmp/x'", URL),
        ("/Users/me/private-repo", URL),
        (URL, "https://attacker.example/acme/app.git"),
    ];
    for (stored, rewritten) in cases {
        let host = Recorded::new(rewritten);
        let out = git::push(
            &host,
            &stage(stored),
            &workspace,
            &scratch,
            push_args("acme/app"),
        )
        .await;
        assert!(out.is_error, "{stored} {rewritten}");
        assert!(!host.ran("push"), "{stored} {rewritten}");
    }
    // A repository named with its host must be the one pushed to.
    let host = Recorded::new("https://attacker.example/acme/app.git");
    let elsewhere = stage("https://attacker.example/acme/app.git");
    let out = git::push(
        &host,
        &elsewhere,
        &workspace,
        &scratch,
        push_args("attacker.example/acme/app"),
    )
    .await;
    assert!(!out.is_error, "{}", out.content);
    let bad = serde_json::from_value(json!({"repo": "acme/app", "branch": "--force"}))
        .unwrap_or_else(|e| panic!("{e}"));
    let host = Recorded::new(URL);
    let out = git::push(&host, &stage(URL), &workspace, &scratch, bad).await;
    assert!(out.is_error && host.launches().is_empty());
}

#[tokio::test]
async fn a_staged_bundle_that_is_a_link_is_never_fetched() {
    let (_dir, workspace, scratch) = workspace();
    let host = Recorded::new(URL);
    let linked = Staging {
        url: URL.to_owned(),
        link: true,
    };
    let out = git::push(&host, &linked, &workspace, &scratch, push_args("acme/app")).await;
    assert!(out.is_error, "{}", out.content);
    assert!(host.launches().is_empty(), "{:?}", host.launches());
}

#[tokio::test]
async fn a_comment_goes_to_gh_with_its_body_on_stdin_only() {
    let (_dir, _workspace, scratch) = workspace();
    let host = Recorded::new("");
    let body = "--repo evil/x Looks good";
    let args = serde_json::from_value(json!({"repo": "acme/app", "number": 7, "body": body}))
        .unwrap_or_else(|e| panic!("{e}"));
    let out = github::comment(&host, &scratch, github::On::PullRequest, args).await;
    assert!(!out.is_error, "{}", out.content);
    let launches = host.launches();
    let [launch] = launches.as_slice() else {
        panic!("{launches:?}");
    };
    assert_eq!(launch.program, "gh");
    assert_eq!(
        launch.args,
        [
            "pr",
            "comment",
            "7",
            "--repo",
            "github.com/acme/app",
            "--body-file",
            "-"
        ]
    );
    assert_eq!(launch.stdin.as_deref(), Some(body));
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn a_message_is_an_argument_to_spades_own_script_never_script_text() {
    let (_dir, _workspace, scratch) = workspace();
    let host = Recorded::new("");
    let body = "\" & (do shell script \"touch /tmp/x\") & \"";
    let args =
        serde_json::from_value(json!({"app": "messages", "to": "+15551234567", "body": body}))
            .unwrap_or_else(|e| panic!("{e}"));
    let out = messages::send(&host, &scratch, args).await;
    assert!(!out.is_error, "{}", out.content);
    let launches = host.launches();
    let [launch] = launches.as_slice() else {
        panic!("{launches:?}");
    };
    assert_eq!(launch.program, "/usr/bin/osascript");
    assert!(launch.args[0].ends_with("send.applescript"));
    assert_eq!(&launch.args[1..3], ["+15551234567", body]);
    let refused = serde_json::from_value(json!({"app": "messages", "to": "-e", "body": "x"}))
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(messages::send(&host, &scratch, refused).await.is_error);
}
