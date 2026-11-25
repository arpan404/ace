// SPDX-License-Identifier: Apache-2.0
//! Native frames (`native-session-bridge.ts:145`-`:166`): the same intake as a JavaScript session's,
//! without building a JavaScript object, and with `ProviderPayload`'s limits enforced where the
//! bridge's constructor enforces them.

use crate::actor::deps::ActorTranslator;
use crate::actor::flow::NativeFlow;
use crate::actor::intake::{self, Ack, FrameInput, Measure};
use crate::actor::state::FrameRef;
use crate::frames::envelope::Envelope;
use crate::futures::channel::oneshot;
use crate::{Core, ThreadId};
use ace_adapter_api::Frame;
use ace_json::Value;
use std::rc::Rc;

/// `maxProviderPayloadBytes` (`provider-kit/src/payload.ts:4`).
const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;

/// `maxProviderPayloadNodes` (`provider-kit/src/payload.ts:11`).
const MAX_PAYLOAD_NODES: usize = 32_768;

/// The `ProviderPayload` constructor's limits, with its own messages.
fn check_payload(text: &str) -> Result<Value, String> {
    if text.len() > MAX_PAYLOAD_BYTES {
        return Err("Provider payload exceeds byte limit".to_string());
    }
    let value = ace_json::parse(text).map_err(|error| error.to_string())?;
    let nodes = count_nodes(&value);
    if nodes > MAX_PAYLOAD_NODES {
        return Err("Provider payload exceeds structural limit".to_string());
    }
    Ok(value)
}

/// Every value popped, containers and primitives alike.
fn count_nodes(value: &Value) -> usize {
    let mut count = 0;
    let mut stack: Vec<&Value> = vec![value];
    while let Some(value) = stack.pop() {
        count += 1;
        match value {
            Value::Array(items) => stack.extend(items.iter()),
            Value::Object(map) => stack.extend(map.values()),
            _ => {}
        }
    }
    count
}

/// `actor::native_frame`: one `SessionEvent::Frame` from a native session, in the bridge's order.
/// `set_paused` is the session's read gate: the flow mirror runs through it, per frame.
#[allow(clippy::too_many_arguments)]
pub fn native_frame(
    core: &Rc<Core>,
    thread: &ThreadId,
    generation: u64,
    frame: Frame,
    now: f64,
    started: f64,
    flow: &mut NativeFlow,
    set_paused: Rc<dyn Fn(bool)>,
) -> (Ack, oneshot::Receiver<Result<(), String>>) {
    let (sender, completion) = oneshot::channel();
    let ack = native_frame_ack(
        core,
        thread,
        generation,
        frame,
        now,
        started,
        flow,
        set_paused,
        Some(sender),
    );
    (ack, completion)
}

/// The same intake, with the acknowledgement sender the caller already holds (the probe's).
#[allow(clippy::too_many_arguments)]
pub fn native_frame_ack(
    core: &Rc<Core>,
    thread: &ThreadId,
    generation: u64,
    frame: Frame,
    now: f64,
    started: f64,
    flow: &mut NativeFlow,
    set_paused: Rc<dyn Fn(bool)>,
    native_ack: Option<oneshot::Sender<Result<(), String>>>,
) -> Ack {
    let bytes = {
        let text = frame.data.get();
        match check_payload(text) {
            Ok(_) => text.len(),
            Err(message) => {
                // The bridge handles the constructor's throw with one warning line and skips the
                // frame: no acknowledgement, no flow mirror, no effect on the actor.
                core.ports
                    .report(format!("native session frame event failed: {message}"));
                if let Some(sender) = native_ack {
                    let _ = sender.send(Ok(()));
                }
                return Ack::Done;
            }
        }
    };
    let t = (now - started).round().max(0.0);
    // The bridge stamps the frame with its delivery time before it translates or captures it.
    let mut frame = frame;
    frame.t = t as i64;
    let envelope = Envelope {
        seq: crate::frames::envelope::Field::Number(frame.seq as f64),
        t: crate::frames::envelope::Field::Number(t),
        ..Envelope::from(&frame)
    };
    let sdk = frame.channel == "sdk";
    let ack = intake::frame(
        core,
        thread,
        generation,
        FrameInput {
            frame: FrameRef::Native(Box::new(frame)),
            envelope,
            channel_sdk: sdk,
            measure: Measure::Certified { bytes },
            native_ack,
        },
    );
    // The flow mirror runs after each delivered frame (`:165`).
    flow.mirror(core, thread, set_paused);
    ack
}

/// The whole frame as the JSON a Cursor SDK journal stores, as the TypeScript's `Frame`.
pub fn frame_value(frame: &Frame) -> Value {
    ace_json::json!({
        "seq": frame.seq,
        "t": frame.t,
        "dir": match frame.dir {
            ace_adapter_api::FrameDirection::Send => "send",
            ace_adapter_api::FrameDirection::Recv => "recv",
            ace_adapter_api::FrameDirection::Stderr => "stderr",
            ace_adapter_api::FrameDirection::Note => "note",
        },
        "channel": frame.channel,
        "data": frame.data.to_value(),
    })
}

/// The frame's `{id, billingMode}`, when it carries an account.
pub fn account_value(frame: &Frame) -> Option<Value> {
    let account = frame.usage_account.as_ref()?;
    let billing_mode = match account.billing_mode {
        ace_adapter_api::BillingMode::Api => "api",
        ace_adapter_api::BillingMode::Subscription => "subscription",
        ace_adapter_api::BillingMode::Unknown => "unknown",
    };
    Some(ace_json::json!({"id": account.id, "billingMode": billing_mode}))
}

/// A native translator's fact as the JSON the fold works on.
pub fn fact_to_value(fact: ace_core::RawFact) -> Option<Value> {
    let text = ace_json::ser::to_string(&fact).ok()?;
    ace_json::parse(&text).ok()
}

/// A native translator, if one is attached to the thread.
pub fn translator(
    core: &Core,
    thread: &ThreadId,
) -> Option<*const dyn ace_adapter_api::Translator> {
    let deps = core.actor_deps.borrow();
    let mut translators = deps.translators.borrow_mut();
    match translators.get_mut(thread) {
        Some((_, ActorTranslator::Native(native))) => {
            Some(native.as_ref() as *const dyn ace_adapter_api::Translator)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::check_payload;

    #[test]
    fn the_bridge_limits_are_the_provider_payload_constructors() {
        let big = format!("\"{}\"", "x".repeat(1024 * 1024));
        assert_eq!(
            check_payload(&big).expect_err("over the byte limit"),
            "Provider payload exceeds byte limit"
        );
        let nodes = format!("[{}]", vec!["0"; 32_769].join(","));
        assert_eq!(
            check_payload(&nodes).expect_err("over the node limit"),
            "Provider payload exceeds structural limit"
        );
        assert!(check_payload("{not json").is_err(), "not JSON is refused");
    }
}
