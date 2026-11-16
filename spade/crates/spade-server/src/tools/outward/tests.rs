use std::sync::Mutex;

use serde_json::json;

use super::host::{Host, HostFuture, HostRan, Launch};
use super::{git, github, messages};

/// Stands in for git, gh and osascript: records each launch and answers `git config` with
/// `url`, everything else with success.
struct Recorded {
    url: String,
    launches: Mutex<Vec<Launch>>,
}

impl Recorded {
    fn new(url: &str) -> Self {
        Self {
            url: url.to_owned(),
            launches: Mutex::default(),
        }
    }

    fn launches(&self) -> Vec<Launch> {
        self.launches.lock().map(|l| l.clone()).unwrap_or_default()
    }
}

impl Host for Recorded {
    fn run(&self, launch: Launch) -> HostFuture {
        let config = launch.args.first().is_some_and(|a| a == "config");
        if let Ok(mut launches) = self.launches.lock() {
            launches.push(launch);
        }
        let stdout = if config {
            format!("{}\n", self.url)
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

/// A workspace holding a repository's `.git` folder, and Spade's scratch folder beside it.
fn workspace() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let root = std::fs::canonicalize(dir.path()).unwrap_or_else(|e| panic!("{e}"));
    let workspace = root.join("workspace");
    std::fs::create_dir_all(workspace.join("app/.git/objects")).unwrap_or_else(|e| panic!("{e}"));
    (dir, workspace, root.join("scratch"))
}

fn push_args(repo: &str) -> git::PushArgs {
    serde_json::from_value(json!({"repo": repo, "branch": "spade/fix", "path": "app"}))
        .unwrap_or_else(|e| panic!("{e}"))
}

#[tokio::test]
async fn a_push_goes_from_a_clean_repository_of_spades_with_hooks_off() {
    let (_dir, workspace, scratch) = workspace();
    let host = Recorded::new("https://github.com/acme/app.git");
    let out = git::push(&host, &workspace, &scratch, push_args("acme/app")).await;
    assert!(!out.is_error, "{}", out.content);
    let launches = host.launches();
    let push = launches.last().map(|l| l.args.clone()).unwrap_or_default();
    assert!(push.contains(&"push".to_owned()), "{push:?}");
    assert!(
        push.contains(&"core.hooksPath=/dev/null".to_owned()),
        "{push:?}"
    );
    assert!(push.contains(&"--no-verify".to_owned()), "{push:?}");
    assert!(push.contains(&"https://github.com/acme/app.git".to_owned()));
    // Nothing runs in the bot's repository: every git starts in Spade's folder, and the push
    // is from the clean one.
    for launch in &launches {
        assert!(launch.dir.starts_with(&scratch), "{launch:?}");
    }
    let from = push.get(1).cloned().unwrap_or_default();
    assert!(
        from.starts_with(&scratch.to_string_lossy().into_owned()),
        "{from}"
    );
    assert!(!scratch.read_dir().is_ok_and(|mut d| d.next().is_some()));
}

#[tokio::test]
async fn a_push_to_another_repository_or_transport_never_starts() {
    let (_dir, workspace, scratch) = workspace();
    for url in [
        "https://github.com/someone/else.git",
        "ext::sh -c 'touch /tmp/x'",
        "/Users/me/private-repo",
    ] {
        let host = Recorded::new(url);
        let out = git::push(&host, &workspace, &scratch, push_args("acme/app")).await;
        assert!(out.is_error, "{url}");
        let pushed = host
            .launches()
            .iter()
            .any(|l| l.args.iter().any(|a| a == "push" || a == "fetch"));
        assert!(!pushed, "{url}");
    }
    let host = Recorded::new("https://github.com/acme/app.git");
    let bad = serde_json::from_value(json!({"repo": "acme/app", "branch": "--force"}))
        .unwrap_or_else(|e| panic!("{e}"));
    let out = git::push(&host, &workspace, &scratch, bad).await;
    assert!(out.is_error && host.launches().is_empty());
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
            "acme/app",
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
