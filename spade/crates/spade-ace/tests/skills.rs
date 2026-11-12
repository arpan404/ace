//! `AceSkills` against a fake daemon WebSocket.

mod support;

use std::time::{Duration, Instant};

use serde_json::json;
use spade_ace::{
    AceSkills, LoopbackUrl, Secret, Skill, SkillErrorCode, SkillScope, SkillsConfig, SkillsError,
};
use support::fake_daemon::{
    DEPLOY, FUTURE, FakeDaemon, LOCAL_TOKEN, REVIEW, SILENT, STALE_WORKSPACE, text_of,
};

fn config(url: &str, token: &str, timeout: Duration) -> SkillsConfig {
    let url = LoopbackUrl::parse(url).unwrap_or_else(|e| panic!("{e}"));
    SkillsConfig::new(url, Secret::new(token), "spade", timeout).unwrap_or_else(|e| panic!("{e}"))
}

fn client(daemon: &FakeDaemon, token: &str, timeout: Duration) -> AceSkills {
    AceSkills::new(config(&daemon.url(), token, timeout))
}

fn expect_review(skill: &Skill) {
    assert_eq!(skill.id, REVIEW);
    assert_eq!(skill.name, "review-code");
    assert_eq!(skill.title.as_deref(), Some("Review code"));
    assert_eq!(skill.description, "review-code skill");
    assert_eq!(skill.scope, SkillScope::Personal);
    assert!(!skill.manual);
    assert_eq!(skill.argument_hint.as_deref(), Some("[branch]"));
    assert_eq!(skill.hash, "a".repeat(64));
}

#[tokio::test]
async fn lists_skills_after_a_hello_with_the_local_token() {
    let daemon = FakeDaemon::start().await;
    let skills = client(&daemon, LOCAL_TOKEN, Duration::from_secs(5));
    let listed = skills.list(None).await.unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(listed.skills.len(), 2);
    assert!(!listed.stale);
    expect_review(&listed.skills[0]);
    assert_eq!(listed.skills[1].scope, SkillScope::Project);
    assert!(listed.skills[1].manual);
    assert_eq!(listed.skills[1].title, None);

    let hellos = daemon.hellos();
    assert_eq!(hellos.len(), 1);
    assert_eq!(hellos[0]["protocolVersion"], json!(1));
    assert_eq!(hellos[0]["deviceId"], json!("spade"));
}

#[tokio::test]
async fn a_listing_keeps_stale_every_entry_field_and_entries_it_cannot_read() {
    let daemon = FakeDaemon::start().await;
    let skills = client(&daemon, LOCAL_TOKEN, Duration::from_secs(5));
    let listed = skills.list(Some(STALE_WORKSPACE)).await;
    let listed = listed.unwrap_or_else(|e| panic!("{e}"));
    assert!(listed.stale);
    assert_eq!(listed.extra.get("cursor"), Some(&json!("next-1")));
    assert_eq!(listed.extra.len(), 1);
    assert_eq!(listed.skills.len(), 2);
    let raw = &listed.skills[0].raw;
    assert_eq!(raw["addedLater"], json!({ "anything": true }));
    assert_eq!(raw["agents"][0]["provider"], json!("claude"));
    assert_eq!(raw["path"], json!("~/.agents/skills/review-code"));
    assert_eq!(
        listed.unreadable,
        vec![json!({ "id": "skl_broken", "scope": "personal" })]
    );
}

#[tokio::test]
async fn reads_a_skill_and_matches_answers_that_arrive_out_of_order() {
    let daemon = FakeDaemon::start().await;
    let skills = client(&daemon, LOCAL_TOKEN, Duration::from_secs(5));
    // The read answers late, so the list's answer arrives first on the same socket.
    let (read, list, other) = tokio::join!(
        skills.read(REVIEW, None),
        skills.list(Some("ws_1")),
        skills.read(DEPLOY, None)
    );
    let read = read.unwrap_or_else(|e| panic!("{e}"));
    expect_review(&read.skill);
    assert_eq!(read.text, text_of(REVIEW));
    assert_eq!(read.raw["kept"], json!([]));
    assert_eq!(list.map(|l| l.skills.len()), Ok(2));
    assert_eq!(other.map(|s| s.skill.name), Ok("deploy".to_owned()));
    assert_eq!(daemon.connections(), 1);
}

#[tokio::test]
async fn an_unknown_skill_is_not_found() {
    let daemon = FakeDaemon::start().await;
    let skills = client(&daemon, LOCAL_TOKEN, Duration::from_secs(5));
    match skills
        .read("skl_0000000000000000000000000000000000000000", None)
        .await
    {
        Err(SkillsError::Daemon { code, message }) => {
            assert_eq!(code, SkillErrorCode::NotFound);
            assert_eq!(message, "No skill with that id.");
        }
        other => panic!("expected not_found, got {other:?}"),
    }
}

#[tokio::test]
async fn a_result_kind_spade_does_not_know_comes_back_whole() {
    let daemon = FakeDaemon::start().await;
    let skills = client(&daemon, LOCAL_TOKEN, Duration::from_secs(5));
    assert_eq!(
        skills.read(FUTURE, None).await.err(),
        Some(SkillsError::UnexpectedResult {
            kind: "hologram".into(),
            raw: json!({ "kind": "hologram", "beam": 3 }),
        })
    );
}

#[tokio::test]
async fn a_refused_token_is_named_and_never_echoed() {
    let daemon = FakeDaemon::start().await;
    let wrong = "not-the-local-token";
    let skills = client(&daemon, wrong, Duration::from_secs(5));
    let error = skills.list(None).await.err();
    assert_eq!(error, Some(SkillsError::Refused));
    assert!(!format!("{error:?}").contains(wrong));
}

#[tokio::test]
async fn a_socket_the_daemon_dropped_is_opened_again() {
    let daemon = FakeDaemon::start().await;
    let skills = client(&daemon, LOCAL_TOKEN, Duration::from_secs(5));
    assert_eq!(skills.list(None).await.map(|l| l.skills.len()), Ok(2));
    // No pause: a request racing the close is sent again on a fresh socket.
    daemon.drop_connections();
    assert_eq!(skills.list(None).await.map(|l| l.skills.len()), Ok(2));
    assert_eq!(daemon.connections(), 2);
}

#[tokio::test]
async fn a_request_the_daemon_never_answers_times_out() {
    let daemon = FakeDaemon::start().await;
    // SILENT never answers; 2 s leaves a slow machine room for the request after it.
    let skills = client(&daemon, LOCAL_TOKEN, Duration::from_secs(2));
    assert_eq!(
        skills.read(SILENT, None).await.err(),
        Some(SkillsError::Timeout)
    );
    // The socket still serves later requests.
    assert_eq!(skills.list(None).await.map(|l| l.skills.len()), Ok(2));
}

#[tokio::test]
async fn requests_given_up_on_leave_nothing_waiting() {
    let daemon = FakeDaemon::start().await;
    let skills = client(&daemon, LOCAL_TOKEN, Duration::from_secs(30));
    assert!(skills.list(None).await.is_ok());
    // Each read is sent, then dropped before the (never coming) answer. More of them than the
    // client lets wait at once.
    for _ in 0..300 {
        let _ = tokio::time::timeout(Duration::from_millis(1), skills.read(SILENT, None)).await;
    }
    assert_eq!(skills.list(None).await.map(|l| l.skills.len()), Ok(2));
}

/// Bigger than the loopback socket buffers, so writing it blocks on a peer that doesn't read.
fn huge() -> String {
    "w".repeat(32 * 1024 * 1024)
}

#[tokio::test]
async fn a_daemon_that_stops_reading_fails_requests_in_time_and_is_let_go() {
    let daemon = FakeDaemon::start_deaf().await;
    let timeout = Duration::from_millis(300);
    let skills = client(&daemon, LOCAL_TOKEN, timeout);
    let huge = huge();
    // The kernel may take a whole frame into its buffers (Windows grows them on loopback), so
    // frames go until one write sticks. The stuck write misses its deadline and the socket is
    // let go, client still alive.
    for _ in 0..4 {
        // Building a 32 MiB frame takes a while in a debug build; the bound is loose for it.
        let request = Instant::now();
        assert!(skills.read(REVIEW, Some(&huge)).await.is_err());
        assert!(
            request.elapsed() < Duration::from_secs(20),
            "{:?}",
            request.elapsed()
        );
        let deadline = Instant::now() + Duration::from_secs(3);
        while !daemon.saw_close() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        if daemon.saw_close() {
            break;
        }
    }
    assert!(daemon.saw_close(), "a stuck write held the socket");

    // Later requests still fail in time rather than queueing forever.
    for _ in 0..3 {
        let request = Instant::now();
        assert!(skills.read(REVIEW, None).await.is_err());
        // The timeout plus slack for a busy machine: bounded, not stuck.
        let bound = timeout + Duration::from_secs(3);
        assert!(request.elapsed() < bound, "{:?}", request.elapsed());
    }
}

#[tokio::test]
async fn dropping_the_client_lets_go_of_a_socket_stuck_writing() {
    let daemon = FakeDaemon::start_deaf().await;
    // Long enough that no deadline ends the stuck write during the test.
    let skills = client(&daemon, LOCAL_TOKEN, Duration::from_secs(60));
    let huge = huge();
    let _ =
        tokio::time::timeout(Duration::from_millis(300), skills.read(REVIEW, Some(&huge))).await;
    assert!(!daemon.saw_close());

    drop(skills);

    let deadline = Instant::now() + Duration::from_secs(5);
    while !daemon.saw_close() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(daemon.saw_close(), "the socket outlived its client");
}

#[tokio::test]
async fn nothing_listening_is_unreachable() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap_or_else(|e| panic!("{e}"));
    let addr = listener.local_addr().unwrap_or_else(|e| panic!("{e}"));
    drop(listener);
    let skills = AceSkills::new(config(
        &format!("ws://{addr}/"),
        LOCAL_TOKEN,
        Duration::from_secs(5),
    ));
    match skills.list(None).await {
        Err(SkillsError::Unreachable(text)) => assert!(!text.contains(LOCAL_TOKEN)),
        other => panic!("expected unreachable, got {other:?}"),
    }
}

#[tokio::test]
async fn a_non_loopback_url_never_becomes_a_skills_config() {
    for url in ["ws://example.com/", "ws://10.0.0.8:4300/"] {
        assert!(LoopbackUrl::parse(url).is_err(), "{url}");
    }
    let http = LoopbackUrl::parse("http://127.0.0.1:4300/").unwrap_or_else(|e| panic!("{e}"));
    assert!(
        SkillsConfig::new(
            http,
            Secret::new(LOCAL_TOKEN),
            "spade",
            Duration::from_secs(1)
        )
        .is_err()
    );
}

#[tokio::test]
async fn a_new_skill_is_created_as_a_personal_skill_for_every_agent() {
    let daemon = FakeDaemon::start().await;
    let skills = client(&daemon, LOCAL_TOKEN, Duration::from_secs(5));
    let created = skills
        .create(spade_ace::NewSkill {
            name: "release-notes",
            description: "Write release notes from merged PRs",
            body: "# Release notes\n\nList the merged PRs first.\n",
            agents: &spade_ace::ALL_AGENTS,
            manual: false,
        })
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(created.skill.name, "release-notes");
    assert!(created.text.contains("List the merged PRs first."));
    let writes = daemon.writes();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0]["op"], json!("create"));
    assert_eq!(writes[0]["scope"], json!({ "kind": "personal" }));
    assert_eq!(
        writes[0]["agents"],
        json!(["claude", "codex", "opencode", "cursor", "pi"])
    );
    assert_eq!(writes[0]["manual"], json!(false));
}

#[tokio::test]
async fn an_edit_names_the_hash_it_was_made_against_and_a_stale_one_is_a_conflict() {
    let daemon = FakeDaemon::start().await;
    let skills = client(&daemon, LOCAL_TOKEN, Duration::from_secs(5));
    let edit = |hash: &'static str| spade_ace::SkillEdit {
        id: REVIEW,
        expected_hash: hash,
        description: "Review code, tests first",
        body: "Read the tests first.\n",
        manual: false,
    };
    let current = "a".repeat(64);
    let edited = skills
        .edit(spade_ace::SkillEdit {
            expected_hash: &current,
            ..edit("")
        })
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(edited.skill.description, "Review code, tests first");
    assert_eq!(daemon.writes()[0]["expectedHash"], json!(current));

    let stale = skills.edit(edit("0000")).await;
    assert!(
        matches!(
            stale,
            Err(SkillsError::Daemon {
                code: SkillErrorCode::Conflict,
                ..
            })
        ),
        "{stale:?}"
    );
}

#[tokio::test]
async fn a_name_already_taken_is_refused_as_existing() {
    let daemon = FakeDaemon::start().await;
    let skills = client(&daemon, LOCAL_TOKEN, Duration::from_secs(5));
    let taken = skills
        .create(spade_ace::NewSkill {
            name: "review-code",
            description: "Again",
            body: "Again.\n",
            agents: &spade_ace::ALL_AGENTS,
            manual: false,
        })
        .await;
    assert!(
        matches!(
            taken,
            Err(SkillsError::Daemon {
                code: SkillErrorCode::Exists,
                ..
            })
        ),
        "{taken:?}"
    );
}
