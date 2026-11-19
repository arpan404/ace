//! Legacy count limits relaxed (ADR 0158): one step's tool calls run sixteen at once by default,
//! through the real engine and a scripted fake model.

mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;
use spade_server::tools::{Tool, ToolFuture, ToolOutput};
use spade_testkit::Script;
use support::{Result, Spade};

/// A read that holds for a moment and notes the most calls of it that ran at once.
struct Peak {
    running: Arc<AtomicUsize>,
    most: Arc<AtomicUsize>,
}

impl Tool for Peak {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: "lookup".into(),
                description: "Looks one thing up.".into(),
                schema: json!({ "type": "object" }),
            },
            risk: Risk::Read,
            untrusted_output: false,
            deferred: false,
            background: false,
        }
    }

    fn run(&self, _key: &str, _arguments: Value) -> ToolFuture {
        let (running, most) = (self.running.clone(), self.most.clone());
        Box::pin(async move {
            let now = running.fetch_add(1, Ordering::SeqCst) + 1;
            most.fetch_max(now, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(400)).await;
            running.fetch_sub(1, Ordering::SeqCst);
            ToolOutput::ok("found")
        })
    }
}

#[tokio::test]
async fn twelve_reads_in_one_step_all_run_at_once() -> Result {
    let most = Arc::new(AtomicUsize::new(0));
    let peak = Peak {
        running: Arc::new(AtomicUsize::new(0)),
        most: most.clone(),
    };
    let mut step = Script::reply("");
    for n in 0..12 {
        step = step.call(&format!("c{n}"), "lookup", json!({}));
    }
    let spade = Spade::start(
        vec![
            step,
            Script::reply("Found all twelve."),
            Script::reply("").plain(r#"{"title":"Lookups"}"#),
        ],
        vec![Arc::new(peak) as Arc<dyn Tool>],
    )
    .await?;
    let id = spade.ask("Look these up").await?;
    spade.wait_for(&id, "reply_finished").await?;
    assert_eq!(
        most.load(Ordering::SeqCst),
        12,
        "they queued four at a time"
    );
    Ok(())
}
