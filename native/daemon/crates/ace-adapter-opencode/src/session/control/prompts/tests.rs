// SPDX-License-Identifier: Apache-2.0
//! Prompt admission's cases (`prompts.ts`): the id, the request that started a
//! send, the 4xx that turned it down, and the answer a failure gets.

use super::{Direction, Outcome, Prompts};

fn observed(prompts: &mut Prompts, direction: Direction, path: &str, status: Option<f64>) {
    prompts.observe(direction, path, status);
}

#[test]
fn an_input_the_server_never_saw_may_be_sent_again() {
    let mut prompts = Prompts::new();
    prompts.begin();
    prompts.next_id(1_700_000_000_000, "abcd");
    // The request failed before it went out.
    assert_eq!(prompts.outcome(false), Outcome::Rejected);
    // Any 4xx, however it arrived, is the server turning it down.
    observed(
        &mut prompts,
        Direction::Recv,
        "/api/session/ses_1/prompt",
        Some(404.0),
    );
    assert_eq!(prompts.outcome(false), Outcome::Rejected);
}

#[test]
fn a_request_that_went_out_without_a_refusal_is_uncertain() {
    let mut prompts = Prompts::new();
    prompts.begin();
    observed(
        &mut prompts,
        Direction::Send,
        "/api/session/ses_1/prompt",
        None,
    );
    assert_eq!(prompts.outcome(false), Outcome::Uncertain);
    // A 5xx may follow a stored prompt: still uncertain.
    observed(
        &mut prompts,
        Direction::Recv,
        "/api/session/ses_1/prompt",
        Some(503.0),
    );
    assert_eq!(prompts.outcome(false), Outcome::Uncertain);
}

#[test]
fn a_4xx_after_the_request_went_out_still_stored_nothing() {
    // The server answered the prompt or command itself with a refusal: nothing was
    // stored, so ace may send the input again.
    let mut prompts = Prompts::new();
    prompts.begin();
    observed(
        &mut prompts,
        Direction::Send,
        "/api/session/ses_1/command",
        None,
    );
    observed(
        &mut prompts,
        Direction::Recv,
        "/api/session/ses_1/command",
        Some(409.0),
    );
    assert_eq!(prompts.outcome(false), Outcome::Rejected);
}

#[test]
fn a_command_batch_that_admitted_one_command_is_uncertain() {
    let mut prompts = Prompts::new();
    prompts.begin();
    // Nothing observed at all (the transport failed first), but a command returned.
    assert_eq!(prompts.outcome(true), Outcome::Uncertain);
}

#[test]
fn only_prompt_and_command_requests_count() {
    let mut prompts = Prompts::new();
    prompts.begin();
    for path in [
        "/api/session/ses_1/message",
        "/api/session/ses_1/interrupt",
        "/api/session/prompted",
    ] {
        observed(&mut prompts, Direction::Send, path, None);
    }
    assert_eq!(prompts.outcome(false), Outcome::Rejected);
}

#[test]
fn a_reply_that_is_not_an_http_status_is_not_a_refusal() {
    let mut prompts = Prompts::new();
    prompts.begin();
    observed(&mut prompts, Direction::Recv, "/api/session/s/prompt", None);
    assert_eq!(prompts.outcome(false), Outcome::Rejected);
    // A 2xx never marks a refusal either, and begin clears a previous send.
    observed(
        &mut prompts,
        Direction::Recv,
        "/api/session/s/prompt",
        Some(400.0),
    );
    prompts.begin();
    assert_eq!(prompts.outcome(false), Outcome::Rejected);
    observed(
        &mut prompts,
        Direction::Recv,
        "/api/session/s/prompt",
        Some(200.0),
    );
    assert_eq!(prompts.outcome(false), Outcome::Rejected);
}

#[test]
fn the_id_moves_forward_and_keeps_the_message_prefix() {
    let mut prompts = Prompts::new();
    let first = prompts.next_id(1_700_000_000_000, "abcdef");
    let second = prompts.next_id(1_700_000_000_000, "abcdef");
    assert!(first.starts_with("msg_"), "{first}");
    assert_eq!(first.len(), 4 + 12 + 6, "{first}");
    assert_ne!(first, second, "the sequence is part of the id");
    assert_ne!(
        &first[4..16],
        &second[4..16],
        "the low 12 bits are the sequence"
    );
}
