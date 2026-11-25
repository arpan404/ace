// SPDX-License-Identifier: Apache-2.0
//! Native frames (`native-session-bridge.ts:145`–`:166`): the same intake as a JavaScript session's,
//! without building a JavaScript object, and with `ProviderPayload`'s limits enforced where the
//! bridge's constructor enforces them.

use crate::actor::deps::ActorTranslator;
use crate::actor::flow::NativeFlow;
use crate::actor::intake::{self, Ack, FrameInput, Measure};
use crate::actor::state::FrameRef;
use crate::frames::envelope::Envelope;
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
pub fn native_frame(
    core: &Rc<Core>,
    thread: &ThreadId,
    generation: u64,
    frame: Frame,
    now: f64,
    started: f64,
    flow: &mut NativeFlow,
) -> Ack {
    let text = frame.data.get();
    match check_payload(text) {
        Ok(_) => {}
        Err(message) => {
            // The bridge handles the constructor's throw with one warning line and skips the
            // frame: no acknowledgement, no flow mirror, no effect on the actor.
            core.ports
                .report(format!("native session frame event failed: {message}"));
            return Ack::Done;
        }
    }
    let t = (now - started).round().max(0.0);
    let envelope = Envelope {
        seq: crate::frames::envelope::Field::Number(frame.seq as f64),
        t: crate::frames::envelope::Field::Number(t),
        ..Envelope::from(&frame)
    };
    let sdk = frame.channel == "sdk";
    let bytes = text.len();
    let ack = intake::frame(
        core,
        thread,
        generation,
        FrameInput {
            frame: FrameRef::Native(Box::new(frame)),
            envelope,
            channel_sdk: sdk,
            measure: Measure::Certified { bytes },
        },
        None,
    );
    // The flow mirror runs after each delivered frame (`:165`).
    let live = core.actor_deps.borrow().live.clone();
    let _ = live;
    let set: Rc<dyn Fn(bool)> = Rc::new(|_paused| {});
    let core_for_flow = Rc::clone(core);
    let thread = thread.clone();
    let mut mirrored = std::mem::take(flow);
    mirrored.mirror(&core_for_flow, &thread, set);
    *flow = mirrored;
    ack
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
