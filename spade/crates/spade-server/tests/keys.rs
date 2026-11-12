//! A key read that waits on the keychain (a prompt nobody answers) holds up only the call that
//! needs that key, never the server's async workers or other agents.

mod support;

use std::time::Duration;

use serde_json::json;
use spade_testkit::{FakeProvider, Script};
use support::{Gate, Options, Result, Spade};

// One worker: a key read done on it would stop everything else.
#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn a_stuck_key_read_for_one_agent_does_not_stop_another_on_a_keyless_endpoint() -> Result {
    let gate = Gate::default();
    let spade = Spade::start_with(
        vec![Script::reply("unused")],
        Vec::new(),
        Options {
            keychain_gate: Some(gate.clone()),
            keychain_gate_for: Some("slow"),
            ..Options::default()
        },
    )
    .await?;
    let open_at_end = OpenOnDrop(gate);
    let slow_fake = FakeProvider::start("Never reached.").await?;
    let local_fake = FakeProvider::start("Local answers.").await?;
    for (name, root, needs_key) in [
        ("Slow", &slow_fake.root, true),
        ("Local", &local_fake.root, false),
    ] {
        let (status, body) = spade
            .post(
                "/v1/endpoints",
                json!({ "name": name, "format": "openai-chat", "base_url": root, "needs_key": needs_key }),
            )
            .await?;
        assert_eq!(status, 201, "{body}");
    }
    let conversation = |agent: &serde_json::Value| {
        agent["agent"]["conversation"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    };
    let (_, stuck) = spade
        .post("/v1/agents", json!({ "name": "Stuck", "model": "slow/m" }))
        .await?;
    let (_, free) = spade
        .post("/v1/agents", json!({ "name": "Free", "model": "local/m" }))
        .await?;
    // A plain thread opens the gate after a while whatever happens, so a held-up runtime (whose
    // own timers stall with it) still comes back and the test fails instead of hanging.
    let release = open_at_end.0.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(4));
        release.open();
    });
    let asked = std::time::Instant::now();
    spade.say(&conversation(&stuck), "Hello?").await?;
    tokio::time::sleep(Duration::from_millis(200)).await;
    spade.say(&conversation(&free), "Hello?").await?;
    let answered = spade
        .wait_for(&conversation(&free), "reply_finished")
        .await?;
    assert!(
        asked.elapsed() < Duration::from_secs(3),
        "the other agent was held up by a stuck key read for {:?}",
        asked.elapsed()
    );
    assert!(
        answered
            .iter()
            .any(|e| e["type"] == "reply_finished" && e["text"] == "Local answers.")
    );
    drop(open_at_end);
    Ok(())
}

struct OpenOnDrop(Gate);

impl Drop for OpenOnDrop {
    fn drop(&mut self) {
        self.0.open();
    }
}
