// SPDX-License-Identifier: Apache-2.0

//! The writer's queue bound, and what becomes of a frame that cannot be encoded.
// Test-only code: a broken frame in the output is a failed assertion, not a gentle error.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use super::*;
use files_wire::{
    Change, ChangeKind, Decoder, Entry, FileMatches, Frame, Kind, LineMatch, PROTOCOL, Page, Reply,
    Summary,
};

/// An `Out` whose writer nobody drains, standing in for a daemon that stopped reading.
fn stalled_out() -> (Out, Receiver<Item>) {
    let (sender, items) = mpsc::channel(QUEUE_ITEMS);
    (Out { sender }, items)
}

fn hello() -> Message {
    Message::Hello {
        protocol: PROTOCOL,
        version: None,
    }
}

#[test]
fn a_paused_reader_holds_a_blocking_producer_at_the_queue_bound() {
    let (out, mut items) = stalled_out();
    for _ in 0..QUEUE_ITEMS {
        out.sender
            .try_send(Item::Message(hello()))
            .expect("the queue starts empty");
    }
    let finished = Arc::new(AtomicBool::new(false));
    let producer = {
        let out = out.clone();
        let finished = Arc::clone(&finished);
        std::thread::spawn(move || {
            out.send_blocking(hello());
            finished.store(true, Ordering::SeqCst);
        })
    };
    std::thread::sleep(Duration::from_millis(100));
    assert!(
        !finished.load(Ordering::SeqCst),
        "a watcher or search sink waits for a reader instead of queueing without bound"
    );

    assert!(
        items.blocking_recv().is_some(),
        "the reader takes one frame"
    );
    producer
        .join()
        .expect("the producer finishes once there is room");
    assert!(finished.load(Ordering::SeqCst));
}

#[tokio::test]
async fn a_paused_reader_holds_an_async_sender_at_the_queue_bound() {
    let (out, mut items) = stalled_out();
    for _ in 0..QUEUE_ITEMS {
        out.sender
            .try_send(Item::Message(hello()))
            .expect("the queue starts empty");
    }
    let send = out.send(hello());
    tokio::pin!(send);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut send)
            .await
            .is_err(),
        "a task waits for room instead of queueing without bound"
    );

    items.recv().await.expect("the reader takes one frame");
    tokio::time::timeout(Duration::from_secs(5), send)
        .await
        .expect("the send finishes once there is room");
}

/// Every message the writer produced, in order.
fn written_messages(bytes: &[u8]) -> Vec<Message> {
    let mut decoder = Decoder::new();
    decoder.push(bytes);
    let mut messages = Vec::new();
    while let Some(frame) = decoder.poll().expect("the writer writes whole frames") {
        match frame {
            Frame::Message(message) => messages.push(message),
            Frame::Body { .. } => panic!("these tests write messages only"),
        }
    }
    messages
}

/// Run one item through the writer and hand back what reached the pipe.
fn write(item: Item) -> (Vec<u8>, VecDeque<Item>) {
    let mut bytes = Vec::new();
    let mut again = VecDeque::new();
    write_item(&mut bytes, item, &mut again).expect("the writer writes");
    while let Some(item) = again.pop_front() {
        write_item(&mut bytes, item, &mut again).expect("the writer writes");
    }
    (bytes, again)
}

/// A page of entries long enough that its response cannot fit in one frame.
fn oversize_page() -> Message {
    let entries: Vec<Entry> = (0..40_000)
        .map(|index| Entry {
            path: format!("{}/file{index}.rs", "folder".repeat(60)),
            name: format!("file{index}.rs"),
            kind: Kind::File,
            size: 0,
            mtime_ms: 0,
            ignored: false,
        })
        .collect();
    Message::Response {
        id: 7,
        result: Reply::Page(Page {
            entries,
            next_cursor: None,
            total: 40_000,
        }),
    }
}

fn oversize_changes() -> Vec<Change> {
    (0..60_000)
        .map(|index| Change {
            path: format!("{}/file{index}.rs", "folder".repeat(60)),
            kind: ChangeKind::Created,
            directory: false,
        })
        .collect()
}

#[test]
fn a_response_too_large_for_one_frame_becomes_a_too_large_error() {
    let (bytes, _) = write(Item::Message(oversize_page()));
    let messages = written_messages(&bytes);
    assert_eq!(
        messages.len(),
        1,
        "the request still gets exactly one answer"
    );
    match &messages[0] {
        Message::Error {
            id, code, message, ..
        } => {
            assert_eq!(*id, 7, "the error answers the request it replaced");
            assert_eq!(code, "TOO_LARGE");
            assert!(
                message.contains("does not fit"),
                "the message says what happened: {message}"
            );
        }
        other => panic!("a response that cannot be encoded answered {other:?}"),
    }
}

#[test]
fn an_oversize_change_batch_is_split_so_every_change_arrives() {
    let changes = oversize_changes();
    let (bytes, _) = write(Item::Message(Message::Event {
        subscription: 3,
        payload: EventPayload::Changes {
            changes: changes.clone(),
        },
    }));
    let messages = written_messages(&bytes);
    assert!(
        messages.len() > 1,
        "a batch over the frame limit arrives as several events"
    );
    let mut delivered = Vec::new();
    for message in messages {
        match message {
            Message::Event {
                subscription: 3,
                payload: EventPayload::Changes { changes },
            } => delivered.extend(changes),
            other => panic!("splitting produced {other:?}"),
        }
    }
    assert_eq!(
        delivered, changes,
        "every change arrives once, in the order the watcher reported it"
    );
}

#[test]
fn an_oversize_event_with_no_split_is_dropped_with_a_warning() {
    let file = FileMatches {
        path: "big.txt".to_owned(),
        lines: (0..40_000)
            .map(|index| LineMatch {
                line: index,
                column: 0,
                preview: "x".repeat(400),
                ranges: vec![(0, 1)],
            })
            .collect(),
    };
    let (bytes, _) = write(Item::Message(Message::Event {
        subscription: 9,
        payload: EventPayload::Matches { file },
    }));
    let messages = written_messages(&bytes);
    assert_eq!(
        messages.len(),
        1,
        "the match event is replaced, never dropped"
    );
    match &messages[0] {
        Message::Event {
            subscription: 9,
            payload: EventPayload::Warning { message },
        } => assert!(
            message.contains("too large"),
            "the warning says why nothing arrived: {message}"
        ),
        other => panic!("an unsplittable event became {other:?}"),
    }
}

#[test]
fn a_summary_that_fits_is_written_as_is() {
    let message = Message::Event {
        subscription: 1,
        payload: EventPayload::SearchDone {
            summary: Summary {
                files: 1,
                bytes: 2,
                matches: 3,
                limit_hit: false,
            },
        },
    };
    let (bytes, _) = write(Item::Message(message.clone()));
    assert_eq!(written_messages(&bytes), vec![message]);
}
