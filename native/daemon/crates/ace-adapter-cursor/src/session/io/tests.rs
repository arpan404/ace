// SPDX-License-Identifier: Apache-2.0
//! The shell's own contract: an input from the facade always answers.

use std::sync::Arc;
use std::sync::mpsc::channel;
use std::time::Duration;

use ace_adapter_api::bridge::queue::SessionEvent;
use ace_json::Value;

use super::super::commands::CursorOpen;
use super::super::core::CursorSessionConfig;
use super::super::envelope::limits;
use super::CursorSessionShell;

fn shell() -> Arc<CursorSessionShell> {
    Arc::new(CursorSessionShell::new(CursorSessionConfig {
        generation: String::from("generation"),
        instance_id: String::from("instance"),
        root_key: String::from("root"),
        limits: limits(&Value::Object(ace_json::Map::new())).expect("the default limits parse"),
        capabilities: String::from("{}"),
    }))
}

fn open(shell: &CursorSessionShell, operation: u64) {
    shell.open(
        operation,
        CursorOpen {
            cwd: "/tmp",
            thread_id: "thread",
            checkpoint_generation: None,
            model: None,
            model_params: None,
            native_session_id: None,
            recover: None,
            permission_mode: None,
            auto_review: false,
            mcp: None,
            instructions: None,
        },
        None,
    );
}

#[test]
fn an_open_with_no_child_answers_instead_of_blocking_the_session() {
    let shell = shell();
    let (sent, answered) = channel();
    let opener = Arc::clone(&shell);
    let worker = std::thread::spawn(move || {
        open(&opener, 1);
        // Sends after the open returns: a second lock inside the open would never get here.
        let _ = sent.send(());
    });
    answered
        .recv_timeout(Duration::from_secs(5))
        .expect("the open blocked on its own state lock");
    worker.join().expect("the open's thread panicked");

    // No child ever took the line, so the refusal settles the facade's open once.
    let batch = shell.queue().take_batch(16, 16_384);
    assert!(
        batch.iter().any(|event| matches!(
            event,
            SessionEvent::Settle {
                id: 1,
                result: Err(_)
            }
        )),
        "the refused open settled nothing"
    );
}
