#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
// SPDX-License-Identifier: Apache-2.0
//! Ports `readCore` from `apps/daemon/src/socket-reads.ts`. The cases follow that file's rules:
//! the accept and reject wording of each message, the subscription cap, the output read's cap,
//! the item page's budget, command statuses, and `false` for a message another owner handles.

use std::cell::Cell;
use std::collections::HashMap;

use ace_fanout::{
    CommandLanes, CoreReader, CoreStore, FailScope, MAX_SUBSCRIPTIONS, ManagedSubscription,
    OUTPUT_READ_BYTES, ReadError, Scope, SubscribeOptions, Subscription, Subscriptions,
    command_lane, read_core,
};
use ace_json::{JsString, Value};

const DEVICE: &str = "phone";

fn parse(text: &str) -> Value {
    ace_json::parse(text).expect("parse JSON")
}

/// What `read_entity_page` was asked: collection, before, limit, max bytes.
type EntityCall = (String, Option<Value>, usize, usize);
/// What `read_bounded_item_page` was asked: before and limit.
type ItemCall = (Option<Value>, usize);

#[derive(Default)]
struct Fake {
    receipts: HashMap<String, Value>,
    output: Option<String>,
    output_data: Option<Value>,
    interaction: Option<Result<Value, String>>,
    thread: bool,
    entity: Option<Result<Value, ReadError>>,
    items: Option<Result<Value, ReadError>>,
    item_budget: Cell<usize>,
    entity_call: std::cell::RefCell<Option<EntityCall>>,
    item_call: std::cell::RefCell<Option<ItemCall>>,
}

impl CoreStore for Fake {
    fn command_receipt(&self, command_id: &str, _device: &str) -> Option<Value> {
        self.receipts.get(command_id).cloned()
    }

    fn output_thread(&self, _stream_id: &str) -> Option<String> {
        self.output.clone()
    }

    fn read_output(&self, _stream_id: &str, _offset: u64, limit: usize) -> Value {
        let mut data = match self.output_data.clone() {
            Some(Value::Object(fields)) => fields,
            _ => ace_json::Map::new(),
        };
        data.insert("limit", Value::Number(ace_json::Number::from(limit as u64)));
        Value::Object(data)
    }

    fn read_interaction_request(
        &self,
        _thread_id: &str,
        _interaction_id: &str,
        _offset: u64,
    ) -> Result<Value, String> {
        self.interaction
            .clone()
            .unwrap_or(Err("interaction_not_found".to_owned()))
    }

    fn read_thread(&self, _thread_id: &str) -> bool {
        self.thread
    }

    fn read_entity_page(
        &self,
        _thread_id: &str,
        collection: &str,
        before: Option<&Value>,
        limit: usize,
        max_bytes: usize,
    ) -> Result<Value, ReadError> {
        *self.entity_call.borrow_mut() =
            Some((collection.to_owned(), before.cloned(), limit, max_bytes));
        self.entity.clone().unwrap_or(Err(ReadError))
    }

    fn read_bounded_item_page(
        &self,
        _thread_id: &str,
        before: Option<&Value>,
        limit: usize,
        max_bytes: usize,
    ) -> Result<Value, ReadError> {
        self.item_budget.set(max_bytes);
        *self.item_call.borrow_mut() = Some((before.cloned(), limit));
        self.items.clone().unwrap_or(Err(ReadError))
    }
}

#[derive(Debug, Default)]
struct Failure {
    code: String,
    message: String,
    scope: (Option<String>, Option<String>),
}

/// One socket's worth of state, and the reads one message causes.
struct Socket {
    subscriptions: Subscriptions,
    sends: Vec<Value>,
    failures: Vec<Failure>,
}

impl Socket {
    fn new() -> Socket {
        Socket {
            subscriptions: Subscriptions::new(),
            sends: Vec::new(),
            failures: Vec::new(),
        }
    }
}

/// Answer one message; `page` and `subscribe` are the shell's closures.
#[allow(clippy::too_many_arguments)]
fn answer(
    socket: &mut Socket,
    store: &dyn CoreStore,
    message: Value,
    lanes: Option<&CommandLanes>,
    authorize: bool,
    can_read: bool,
    page: &mut ace_fanout::PageFn<'_>,
    subscribe: &mut ace_fanout::SubscribeFn<'_>,
) -> bool {
    let mut sends = std::mem::take(&mut socket.sends);
    let mut failures = std::mem::take(&mut socket.failures);
    let plain_store = MemStore;
    let authorize = move |requested: &str| authorize && requested == "read";
    let can_read = move |_thread: &str| can_read;
    let mut send = |message: Value| sends.push(message);
    let mut fail = |code: &str, message: &str, _close: bool, scope: FailScope<'_>| {
        failures.push(Failure {
            code: code.to_owned(),
            message: message.to_owned(),
            scope: (
                scope.request_id.map(str::to_owned),
                scope.subscription_id.map(str::to_owned),
            ),
        })
    };
    let handled = {
        let mut reader = CoreReader {
            store,
            subscription_store: &plain_store,
            subscriptions: &mut socket.subscriptions,
            device: DEVICE,
            authorize: &authorize,
            can_read_thread: Some(&can_read),
            lanes,
            replay_limit: 5000,
            send: &mut send,
            fail: &mut fail,
            page,
            subscribe,
        };
        read_core(&message, &mut reader)
    };
    socket.sends = sends;
    socket.failures = failures;
    handled
}

/// A message carrying the scope under test; `answer` only reads `type` and `scope`.
fn scope_message(scope: Scope) -> Value {
    let mut message = ace_json::Map::with_capacity(4);
    message.insert("type", Value::String(JsString::from("subscribe")));
    message.insert("subscriptionId", Value::String(JsString::from("s")));
    let mut value = ace_json::Map::with_capacity(1);
    match scope {
        Scope::Thread(thread) => {
            value.insert("kind", Value::String(JsString::from("thread")));
            value.insert("threadId", Value::String(JsString::from(thread)));
        }
        _ => {
            value.insert("kind", Value::String(JsString::from("threads")));
        }
    }
    message.insert("scope", Value::Object(value));
    Value::Object(message)
}

struct MemStore;

impl ace_fanout::SubscriptionStore for MemStore {
    fn head_seq(&self) -> u64 {
        0
    }

    fn get_thread(&self, _thread: &str) -> bool {
        true
    }

    fn snapshot_thread(&self, _thread: &str, _tail: Option<ace_fanout::SnapshotTail>) -> Value {
        Value::Null
    }

    fn list_threads(&self) -> Value {
        Value::Null
    }

    fn read_events(
        &self,
        _after: u64,
        _limit: usize,
        _byte_limit: usize,
        _head: u64,
        _thread: Option<&str>,
    ) -> ace_fanout::EventRead {
        ace_fanout::EventRead::complete(Vec::new())
    }
}

fn subscribe_nothing(_: &mut Subscriptions, _: &Value) -> Result<(), ReadError> {
    Err(ReadError)
}

fn page_nothing(
    _: &mut Subscriptions,
    _: &str,
    _: &ace_fanout::ThreadListCursor,
    _: &str,
) -> Result<Value, ReadError> {
    Err(ReadError)
}

fn one(message: &str) -> Value {
    parse(message)
}

/// A message for another owner returns `false` and changes nothing.
#[test]
fn a_message_another_owner_handles_is_not_answered() {
    let mut socket = Socket::new();
    let store = Fake::default();
    let handled = answer(
        &mut socket,
        &store,
        one(r#"{"type":"thread.address","requestId":"r"}"#),
        None,
        true,
        true,
        &mut page_nothing,
        &mut subscribe_nothing,
    );
    assert!(!handled);
    assert!(socket.sends.is_empty() && socket.failures.is_empty());
}

/// A subscribe without the read scope is refused `forbidden`, naming the subscription.
#[test]
fn a_subscribe_without_read_scope_is_forbidden() {
    let mut socket = Socket::new();
    let store = Fake::default();
    answer(
        &mut socket,
        &store,
        scope_message(Scope::Thread("t".to_owned())),
        None,
        false,
        true,
        &mut page_nothing,
        &mut subscribe_nothing,
    );
    assert_eq!(socket.failures.len(), 1);
    assert_eq!(socket.failures[0].code, "forbidden");
    assert_eq!(socket.failures[0].message, "Read scope required");
    assert_eq!(socket.failures[0].scope, (None, Some("s".to_owned())));
}

/// "Too many subscriptions" once the socket holds 64.
#[test]
fn the_sixty_fifth_subscription_is_refused() {
    let mut socket = Socket::new();
    for index in 0..MAX_SUBSCRIPTIONS {
        socket.subscriptions.insert(
            &format!("s{index}"),
            ManagedSubscription::Plain(Box::new(Subscription::new(
                JsString::from("s"),
                Scope::Threads,
                None,
                SubscribeOptions::default(),
            ))),
        );
    }
    let store = Fake::default();
    answer(
        &mut socket,
        &store,
        scope_message(Scope::Thread("t".to_owned())),
        None,
        true,
        true,
        &mut page_nothing,
        &mut subscribe_nothing,
    );
    assert_eq!(socket.failures[0].code, "subscription_limit");
    assert_eq!(socket.failures[0].message, "Too many subscriptions");
}

/// A thread this device cannot read is refused `read_denied` before anything is built.
#[test]
fn an_unreadable_thread_is_refused_before_the_subscription_exists() {
    let mut socket = Socket::new();
    let store = Fake::default();
    answer(
        &mut socket,
        &store,
        scope_message(Scope::Thread("secret".to_owned())),
        None,
        true,
        false,
        &mut page_nothing,
        &mut subscribe_nothing,
    );
    assert_eq!(socket.failures[0].code, "read_denied");
    assert_eq!(socket.failures[0].message, "Thread is not readable");
    assert_eq!(socket.subscriptions.len(), 0);
}

/// A creation that fails (an unknown thread, an invalid cursor) is `subscribe_failed`.
#[test]
fn a_failed_creation_is_subscribe_failed() {
    let mut socket = Socket::new();
    let store = Fake::default();
    answer(
        &mut socket,
        &store,
        scope_message(Scope::Thread("t".to_owned())),
        None,
        true,
        true,
        &mut page_nothing,
        &mut subscribe_nothing,
    );
    assert_eq!(socket.failures[0].code, "subscribe_failed");
    assert_eq!(
        socket.failures[0].message,
        "Unknown thread or invalid cursor"
    );
}

/// A page on a subscription that isn't there is `page_failed`, naming only the request: the
/// TypeScript's `fail` scope for `threads.page` carries no subscription id.
#[test]
fn a_page_without_its_subscription_is_page_failed() {
    let mut socket = Socket::new();
    let store = Fake::default();
    answer(
        &mut socket,
        &store,
        one(
            r#"{"type":"threads.page","subscriptionId":"nope","requestId":"p","before":{"at":1,"id":"t"}}"#,
        ),
        None,
        true,
        true,
        &mut page_nothing,
        &mut subscribe_nothing,
    );
    assert_eq!(socket.failures[0].code, "page_failed");
    assert_eq!(socket.failures[0].scope, (Some("p".to_owned()), None));
}

/// An output read's limit never passes `outputReadBytes`, whatever was asked.
#[test]
fn an_output_read_is_capped_at_its_page() {
    let mut socket = Socket::new();
    let store = Fake {
        output: Some("stream-1".to_owned()),
        output_data: Some(one(r#"{"data":"aGk=","nextOffset":2,"eof":true}"#)),
        ..Fake::default()
    };
    answer(
        &mut socket,
        &store,
        one(
            r#"{"type":"output.read","requestId":"o","streamId":"stream-1","offset":0,"limit":1000000}"#,
        ),
        None,
        true,
        true,
        &mut page_nothing,
        &mut subscribe_nothing,
    );
    let sent = &socket.sends[0];
    assert_eq!(
        sent.get("type").and_then(|value| match value {
            Value::String(seen) => Some(seen.as_str()),
            _ => None,
        }),
        Some("output.data")
    );
    assert_eq!(
        sent.get("limit").and_then(|value| match value {
            Value::Number(seen) => Some(seen.value() as usize),
            _ => None,
        }),
        Some(OUTPUT_READ_BYTES)
    );
    assert_eq!(
        sent.get("data").and_then(|value| match value {
            Value::String(seen) => Some(seen.as_str()),
            _ => None,
        }),
        Some("aGk=")
    );
}

/// An unreadable output stream answers "Output stream is not readable".
#[test]
fn an_unreadable_output_stream_is_refused() {
    let mut socket = Socket::new();
    let store = Fake {
        output: Some("stream-1".to_owned()),
        ..Fake::default()
    };
    answer(
        &mut socket,
        &store,
        one(
            r#"{"type":"output.read","requestId":"o","streamId":"stream-1","offset":0,"limit":10}"#,
        ),
        None,
        true,
        false,
        &mut page_nothing,
        &mut subscribe_nothing,
    );
    assert_eq!(socket.failures[0].code, "read_denied");
    assert_eq!(socket.failures[0].message, "Output stream is not readable");
}

/// A missing interaction says so in the TypeScript's words.
#[test]
fn a_missing_interaction_says_this_thread_has_no_such_request() {
    let mut socket = Socket::new();
    let store = Fake {
        interaction: Some(Err("interaction_not_found".to_owned())),
        ..Fake::default()
    };
    answer(
        &mut socket,
        &store,
        one(
            r#"{"type":"interaction.read","requestId":"i","threadId":"t","interactionId":"x","offset":0}"#,
        ),
        None,
        true,
        true,
        &mut page_nothing,
        &mut subscribe_nothing,
    );
    assert_eq!(socket.failures[0].code, "interaction_not_found");
    assert_eq!(
        socket.failures[0].message,
        "This thread has no such request"
    );
}

/// An item page's budget is 1 MiB less its envelope and 128 bytes.
#[test]
fn an_item_pages_budget_is_a_megabyte_less_its_envelope() {
    let mut socket = Socket::new();
    let store = Fake {
        thread: true,
        items: Some(Ok(one(r#"{"threadId":"t","items":[],"itemsBefore":null}"#))),
        ..Fake::default()
    };
    answer(
        &mut socket,
        &store,
        one(r#"{"type":"items.page","requestId":"p","threadId":"t","limit":50}"#),
        None,
        true,
        true,
        &mut page_nothing,
        &mut subscribe_nothing,
    );
    let envelope = r#"{"type":"items.page","requestId":"p","threadId":"t"}"#.len();
    assert_eq!(store.item_budget.get(), 1024 * 1024 - envelope - 128);
    assert_eq!(socket.sends.len(), 1);
}

/// An entity page on a thread that isn't readable says "Thread is not readable".
#[test]
fn an_entity_page_on_an_unreadable_thread_is_refused() {
    let mut socket = Socket::new();
    let store = Fake {
        thread: false,
        ..Fake::default()
    };
    answer(
        &mut socket,
        &store,
        one(
            r#"{"type":"entities.page","requestId":"e","threadId":"t","collection":"agents","limit":10,"maxBytes":1024}"#,
        ),
        None,
        true,
        true,
        &mut page_nothing,
        &mut subscribe_nothing,
    );
    assert_eq!(socket.failures[0].code, "read_denied");
    assert_eq!(socket.failures[0].message, "Thread is not readable");
}

/// The messages `readCore` answers, as `CoreClientMessage.parse` builds them: the protocol's own
/// field names, never a shape invented beside them. A read that misnames a field gets a message
/// no client sent and fails here.
fn wire_message(name: &str) -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/vectors/reads.json");
    let text = std::fs::read_to_string(path).expect("read reads.json");
    let fixture = parse(&text);
    fixture
        .get("messages")
        .and_then(|messages| messages.get(name))
        .cloned()
        .unwrap_or_else(|| panic!("reads.json has no {name}"))
}

fn reply_type(value: &Value) -> &str {
    match value.get("type") {
        Some(Value::String(seen)) => seen.as_str(),
        _ => panic!("no type"),
    }
}

/// Command status reads the protocol's `commandIds`, sends a settled receipt again as a
/// `commandResult`, then every command's state in one `command.status`; work on a lane is
/// running.
#[test]
fn command_status_sends_settled_results_and_each_state() {
    let mut sockets = Socket::new();
    let store = Fake {
        receipts: HashMap::from([("c1".to_owned(), one(r#"{"commandId":"c1","ok":true}"#))]),
        ..Fake::default()
    };
    let mut lanes = CommandLanes::new();
    let command =
        one(r#"{"id":"c2","deviceId":"phone","payload":{"type":"thread.send","threadId":"t"}}"#);
    lanes.run(&command_lane(&command, DEVICE), DEVICE, "c2");
    answer(
        &mut sockets,
        &store,
        wire_message("commandStatus"),
        Some(&lanes),
        true,
        true,
        &mut page_nothing,
        &mut subscribe_nothing,
    );
    assert_eq!(sockets.sends.len(), 2);
    let result = &sockets.sends[0];
    assert_eq!(reply_type(result), "commandResult");
    let status = &sockets.sends[1];
    assert_eq!(reply_type(status), "command.status");
    assert_eq!(
        status.get("requestId").and_then(|request| match request {
            Value::String(seen) => Some(seen.as_str()),
            _ => None,
        }),
        Some("status-1")
    );
    let Some(Value::Array(commands)) = status.get("commands") else {
        panic!("commands");
    };
    let states: Vec<&str> = commands
        .iter()
        .map(|command| match command.get("state") {
            Some(Value::String(seen)) => seen.as_str(),
            _ => panic!("state"),
        })
        .collect();
    assert_eq!(states, vec!["settled", "running", "unknown"]);
    let ids: Vec<&str> = commands
        .iter()
        .map(|command| match command.get("commandId") {
            Some(Value::String(seen)) => seen.as_str(),
            _ => panic!("commandId"),
        })
        .collect();
    assert_eq!(ids, vec!["c1", "c2", "c3"]);
}

/// Every other read the core answers takes the protocol's message and answers with its reply:
/// the audit that no field is read under a name the schema never sends.
#[test]
fn every_read_answers_the_protocols_message() {
    let mut socket = Socket::new();
    socket.subscriptions.insert(
        "s1",
        ManagedSubscription::Plain(Box::new(Subscription::new(
            JsString::from("s1"),
            Scope::Thread("t_tree".to_owned()),
            None,
            SubscribeOptions::default(),
        ))),
    );
    let store = Fake {
        output: Some("stream-1".to_owned()),
        output_data: Some(one(r#"{"data":"aGk=","nextOffset":2,"eof":true}"#)),
        interaction: Some(Ok(one(
            r#"{"offset":0,"nextOffset":1,"eof":true,"json":"{}"}"#,
        ))),
        thread: true,
        entity: Some(Ok(one(r#"{"collection":"interactions","entries":[]}"#))),
        items: Some(Ok(one(
            r#"{"threadId":"t_tree","items":[],"itemsBefore":null}"#,
        ))),
        ..Fake::default()
    };

    let pages: std::cell::RefCell<Vec<(String, u64, String, String)>> =
        std::cell::RefCell::new(Vec::new());
    let mut page = |_: &mut Subscriptions,
                    subscription: &str,
                    cursor: &ace_fanout::ThreadListCursor,
                    request: &str| {
        pages.borrow_mut().push((
            subscription.to_owned(),
            cursor.at,
            cursor.id.clone(),
            request.to_owned(),
        ));
        Ok(parse(
            r#"{"type":"threads.patch","subscriptionId":"s1","seq":1,"threads":{},"removed":[],"window":{}}"#,
        ))
    };
    let subscriptions: std::cell::RefCell<Vec<Value>> = std::cell::RefCell::new(Vec::new());
    let mut subscribe = |_: &mut Subscriptions, message: &Value| {
        subscriptions.borrow_mut().push(message.clone());
        Ok(())
    };

    let cases: [(&str, Option<&str>); 8] = [
        ("threadsPage", Some("threads.patch")),
        ("subscribeThread", None),
        ("subscribeWindow", None),
        ("outputRead", Some("output.data")),
        ("interactionRead", Some("interaction.data")),
        ("itemsPage", Some("items.page")),
        ("entitiesPage", Some("entities.page")),
        ("unsubscribe", None),
    ];
    for (name, reply) in cases {
        let handled = answer(
            &mut socket,
            &store,
            wire_message(name),
            None,
            true,
            true,
            &mut page,
            &mut subscribe,
        );
        assert!(handled, "{name} is a core read");
        assert!(socket.failures.is_empty(), "{name} answered a failure");
        if let Some(reply) = reply {
            assert_eq!(
                socket.sends.last().map(reply_type),
                Some(reply),
                "{name} reply"
            );
        }
    }

    assert_eq!(
        pages.borrow().as_slice(),
        [("s1".to_owned(), 7, "t_tree".to_owned(), "page-1".to_owned())],
        "threads.page passes its subscription, cursor and request"
    );
    let subscriptions = subscriptions.borrow();
    let thread = &subscriptions[0];
    let scope = thread.get("scope").expect("scope");
    assert_eq!(text_of(scope, "kind"), "thread");
    assert_eq!(text_of(scope, "threadId"), "t_tree");
    assert_eq!(number_of(thread, "afterSeq"), 5.0);
    assert_eq!(thread.get("paced"), Some(&Value::Bool(true)));
    let tail = thread.get("tail").expect("tail");
    assert_eq!(number_of(tail, "items"), 10.0);
    assert_eq!(number_of(tail, "bytes"), 4096.0);
    let window = subscriptions[1]
        .get("scope")
        .and_then(|scope| scope.get("window"))
        .expect("window");
    assert_eq!(number_of(window, "limit"), 20.0);
    assert_eq!(text_of(window, "project"), "w_one");
    assert_eq!(window.get("archived"), Some(&Value::Bool(false)));
    let resume = window.get("resume").expect("resume");
    assert_eq!(text_of(resume, "epoch"), "token:activity:0");
    assert_eq!(number_of(resume, "revision"), 3.0);

    let entity = store.entity_call.borrow();
    let (collection, before, limit, max_bytes) = entity.as_ref().expect("entity read");
    assert_eq!(collection, "interactions");
    assert_eq!(number_value(before.as_ref()), Some(6.0));
    assert_eq!((*limit, *max_bytes), (10, 16 * 1024));
    let item = store.item_call.borrow();
    let (before, limit) = item.as_ref().expect("item read");
    assert_eq!(number_value(before.as_ref()), Some(6.0));
    assert_eq!(*limit, 50);

    let output = &socket.sends[1];
    assert_eq!(text_of(output, "streamId"), "stream-1");
    assert_eq!(number_of(output, "offset"), 0.0);
    assert_eq!(text_of(output, "data"), "aGk=");
    let interaction = &socket.sends[2];
    assert_eq!(text_of(interaction, "threadId"), "t_tree");
    assert_eq!(text_of(interaction, "interactionId"), "i1");
    assert_eq!(text_of(&socket.sends[3], "threadId"), "t_tree");
    assert_eq!(reply_type(&socket.sends[4]), "entities.page");
    assert!(
        !socket.subscriptions.contains("s1"),
        "unsubscribe removed it"
    );
}

fn text_of<'a>(value: &'a Value, key: &str) -> &'a str {
    match value.get(key) {
        Some(Value::String(seen)) => seen.as_str(),
        _ => panic!("{key} is not a string"),
    }
}

fn number_of(value: &Value, key: &str) -> f64 {
    match value.get(key) {
        Some(Value::Number(seen)) => seen.value(),
        _ => panic!("{key} is not a number"),
    }
}

fn number_value(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(seen)) => Some(seen.value()),
        _ => None,
    }
}
