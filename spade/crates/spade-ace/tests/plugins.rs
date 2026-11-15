//! The person's accepted plugins through `AceSkills`, against a fake daemon WebSocket.

mod support;

use std::time::Duration;

use spade_ace::plugins::{Execution, KnownExecution};
use spade_ace::{AceSkills, LoopbackUrl, Secret, SkillsConfig, SkillsError};
use support::fake_daemon::{FakeDaemon, LOCAL_TOKEN};

fn client(daemon: &FakeDaemon) -> AceSkills {
    let url = LoopbackUrl::parse(&daemon.url()).unwrap_or_else(|e| panic!("{e}"));
    let config = SkillsConfig::new(
        url,
        Secret::new(LOCAL_TOKEN),
        "spade",
        Duration::from_secs(5),
    );
    AceSkills::new(config.unwrap_or_else(|e| panic!("{e}")))
}

#[tokio::test]
async fn a_plugin_turned_off_in_ace_lists_as_off() {
    let daemon = FakeDaemon::start().await;
    let listed = client(&daemon).plugins().await;
    let listed = listed.unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].install.name, "style-kit");
    assert!(!listed[0].enabled);
}

#[tokio::test]
async fn one_plugin_arrives_with_its_rule_text_and_its_server_as_accepted() {
    let daemon = FakeDaemon::start().await;
    let skills = client(&daemon);
    let plugin = skills.plugin_for_spade("style-kit").await;
    let plugin = plugin.unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(plugin.components[0].text.as_deref(), Some("Use tabs."));
    assert!(matches!(
        &plugin.executions[0],
        Execution::Known(KnownExecution::Stdio { name, args, .. })
            if name == "lint" && args == &["${PLUGIN_ROOT}/lint.js".to_owned()]
    ));
    // Requests run one at a time on one socket, as the daemon takes them.
    let (a, b) = tokio::join!(skills.plugins(), skills.plugin_for_spade("style-kit"));
    assert!(a.is_ok() && b.is_ok());
    let missing = skills.plugin_for_spade("gone").await;
    assert!(
        matches!(missing, Err(SkillsError::Daemon { .. })),
        "{missing:?}"
    );
}
