// SPDX-License-Identifier: Apache-2.0
//! The device platform's input and UI exports (D3.2): the scrcpy control bytes and plans, the
//! Simulator's fingers, keys, screens and accessibility tree, uiautomator's tree, and the two
//! platforms' posture reads. Every function translates arguments and one JSON answer; nothing
//! here decides anything.

use ace_devices::platform::{
    Error,
    android_ui::{self, ActOptions, FindOptions, TreeOptions},
    clipboard,
    device_input::Key,
    fingers, helper, keys, posture,
    scrcpy::{input as scrcpy_input, protocol as scrcpy_protocol},
    screens, simulator_ax,
};
use ace_json::Value;
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

use super::answered;

/// Reads a JSON document `JSON.stringify` wrote, through `ace-json`.
fn json(text: &str) -> napi::Result<Value> {
    ace_json::parse(text).map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))
}

/// Reads a typed value out of a JSON document.
fn parse<T: serde::de::DeserializeOwned>(text: &str) -> napi::Result<T> {
    let value = json(text)?;
    ace_json::from_value(&value)
        .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))
}

fn key(text: &str) -> napi::Result<Key> {
    Ok(match text {
        "home" => Key::Home,
        "back" => Key::Back,
        "rotate" => Key::Rotate,
        "enter" => Key::Enter,
        "power" => Key::Power,
        "recents" => Key::Recents,
        "volumeUp" => Key::VolumeUp,
        "volumeDown" => Key::VolumeDown,
        "action" => Key::Action,
        "side" => Key::Side,
        "keyboard" => Key::Keyboard,
        other => {
            return Err(napi::Error::from_reason(format!(
                "ace-devices: unknown device key: {other}"
            )));
        }
    })
}

fn posture_of(text: &str) -> napi::Result<posture::Posture> {
    Ok(match text {
        "closed" => posture::Posture::Closed,
        "partiallyOpen" => posture::Posture::PartiallyOpen,
        "open" => posture::Posture::Open,
        other => {
            return Err(napi::Error::from_reason(format!(
                "ace-devices: unknown device posture: {other}"
            )));
        }
    })
}

fn turn_of(turn: u16) -> napi::Result<simulator_ax::Turn> {
    Ok(match turn {
        90 => simulator_ax::Turn::Quarter,
        180 => simulator_ax::Turn::Half,
        270 => simulator_ax::Turn::ThreeQuarters,
        _ => simulator_ax::Turn::None,
    })
}

/// The bytes the scrcpy control socket carries for one message. `pointerId` and `sequence`
/// cross as their decimal digits, so a `bigint` keeps every bit.
#[napi]
pub fn device_platform_scrcpy_encode(message: String) -> napi::Result<Buffer> {
    let message: scrcpy_protocol::ControlMessage = parse(&message)?;
    let bytes = scrcpy_protocol::encode(&message)
        .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))?;
    Ok(Buffer::from(bytes))
}

/// One device input as the control messages the scrcpy server accepts.
#[napi]
pub fn device_platform_scrcpy_input_plan(
    input: String,
    display: String,
    video: String,
    next_sequence: i64,
) -> napi::Result<String> {
    let input: ace_devices::platform::device_input::DeviceInput = parse(&input)?;
    let display: scrcpy_protocol::ScreenSize = parse(&display)?;
    let video: scrcpy_protocol::ScreenSize = parse(&video)?;
    let sequence = u64::try_from(next_sequence)
        .map_err(|_| napi::Error::from_reason("ace-devices: a sequence is not negative"))?;
    answered(|| scrcpy_input::plan(&input, display, video, sequence))
}

/// The fingers still down when control moves on, as the inputs that lift them.
#[napi]
pub fn device_platform_held_pointers_release(held: Vec<String>) -> napi::Result<String> {
    let mut pointers = scrcpy_input::HeldPointers::new();
    for input in held {
        let input: ace_devices::platform::device_input::DeviceInput = parse(&input)?;
        pointers.apply(&input);
    }
    ace_json::ser::to_string(&pointers.release())
        .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))
}

/// One operation on the Simulator's held fingers, with the messages it sends serve-sim.
#[napi]
pub fn device_platform_finger_step(op: String, held: String) -> napi::Result<String> {
    let op: fingers::FingerOp = parse(&op)?;
    let held: fingers::HeldFingers = parse(&held)?;
    answered(|| fingers::step(&op, &held))
}

/// The key a device has no hardware for, or `null` when it has one.
#[napi]
pub fn device_platform_key_refusal(
    ios: bool,
    name: String,
    key_name: String,
) -> napi::Result<Option<String>> {
    let key = key(&key_name)?;
    let Some(error) = keys::key_refusal(ios, &name, key) else {
        return Ok(None);
    };
    let failure = match error {
        Error::Refused(refusal) => ace_json::json!({
            "code": refusal.code.as_str(),
            "message": refusal.message,
            "hint": refusal.hint,
        }),
        Error::Failed(failure) => ace_json::json!({
            "code": failure.code.as_str(),
            "message": failure.message,
            "hint": failure.hint,
        }),
        Error::Invalid(detail) => {
            return Err(napi::Error::from_reason(format!("ace-devices: {detail}")));
        }
    };
    Ok(Some(ace_json::ser::to_string(&failure).unwrap_or_default()))
}

/// What a live view's touch input reaches: `multi`, `pointer` or `gestures`.
#[napi]
pub fn device_platform_device_touch(ios: bool, multi_touch: bool, input: bool) -> String {
    keys::device_touch(ios, multi_touch, input).to_string()
}

/// Clipboard text bounded to the budget both backends use, never splitting a surrogate pair.
#[napi]
pub fn device_platform_bounded_clipboard(text: String, cut: bool) -> napi::Result<String> {
    let text: String = parse(&text)?;
    ace_json::ser::to_string(&clipboard::bounded(&text, cut))
        .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))
}

/// Android's clipboard refused without ace's live view.
#[napi]
pub fn device_platform_android_clipboard_refusal() -> napi::Result<String> {
    answered(|| Err::<(), _>(clipboard::android_unavailable()))
}

/// The built-in screens a `devicectl` report lists.
#[napi]
pub fn device_platform_simulator_screens(report: String) -> napi::Result<String> {
    let report = json(&report)?;
    ace_json::ser::to_string(&screens::read_screens(&report))
        .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))
}

/// The display a touch belongs to.
#[napi]
pub fn device_platform_touch_target(screens: String, picture: Option<String>) -> napi::Result<u32> {
    let screens: Vec<screens::SimulatorScreen> = parse(&screens)?;
    let picture = match picture {
        Some(picture) => {
            let picture = json(&picture)?;
            let width = picture
                .get("width")
                .and_then(Value::as_f64)
                .ok_or_else(|| napi::Error::from_reason("ace-devices: a picture needs a width"))?;
            let height = picture
                .get("height")
                .and_then(Value::as_f64)
                .ok_or_else(|| napi::Error::from_reason("ace-devices: a picture needs a height"))?;
            Some((width, height))
        }
        None => None,
    };
    Ok(u32::from(screens::touch_target(&screens, picture)))
}

/// A device's posture from a `devicectl` display report.
#[napi]
pub fn device_platform_posture_read(
    report: String,
    requested: Option<String>,
) -> napi::Result<Option<String>> {
    let report = json(&report)?;
    let requested = match requested {
        Some(requested) => Some(posture_of(&requested)?),
        None => None,
    };
    Ok(posture::read_posture(&report, requested)
        .map(|posture| ace_json::ser::to_string(&posture).unwrap_or_else(|_| "null".to_string())))
}

/// The hinge angle a posture folds to.
#[napi]
pub fn device_platform_posture_angle(posture_name: String) -> napi::Result<u16> {
    Ok(posture::posture_angle(posture_of(&posture_name)?))
}

/// How many screens a `devicectl` report lists, when it can be read.
#[napi]
pub fn device_platform_screen_count(report: String) -> napi::Result<Option<u32>> {
    let report = json(&report)?;
    Ok(posture::screen_count(&report).map(|count| count as u32))
}

/// Whether `emu sensor status` lists a hinge.
#[napi]
pub fn device_platform_has_hinge(status: String) -> bool {
    posture::has_hinge(&status)
}

/// The posture a hinge angle stands for.
#[napi]
pub fn device_platform_posture_from_hinge(reply: String) -> Option<String> {
    posture::posture_from_hinge(&reply)
        .map(|posture| ace_json::ser::to_string(&posture).unwrap_or_else(|_| "null".to_string()))
}

/// uiautomator's XML as ADR 0011 nodes.
#[napi]
pub fn device_platform_android_tree(xml: String, options: String) -> napi::Result<String> {
    let options: TreeOptions = parse(&options)?;
    answered(|| android_ui::tree(&xml, options))
}

/// The nodes a find names in a tree.
#[napi]
pub fn device_platform_android_find(tree: String, options: String) -> napi::Result<String> {
    let tree: android_ui::Tree = parse(&tree)?;
    let options: FindOptions = parse(&options)?;
    ace_json::ser::to_string(&android_ui::find(&tree, &options))
        .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))
}

/// The node a ref names, or the stale-ref refusal.
#[napi]
pub fn device_platform_android_target(tree: String, reference: String) -> napi::Result<String> {
    let tree: android_ui::Tree = parse(&tree)?;
    answered(|| android_ui::target(&tree, &reference))
}

/// The input a semantic action on an Android node becomes.
#[napi]
pub fn device_platform_android_act(node: String, action: String) -> napi::Result<String> {
    let node: android_ui::Node = parse(&node)?;
    let action: ActOptions = parse(&action)?;
    answered(|| android_ui::act(&node, &action))
}

/// serve-sim's `/ax` answer as ADR 0011 nodes.
#[napi]
pub fn device_platform_simulator_tree(
    raw: String,
    screen: String,
    options: String,
) -> napi::Result<String> {
    let raw = json(&raw)?;
    let screen: simulator_ax::Screen = parse(&screen)?;
    let options: TreeOptions = parse(&options)?;
    answered(|| simulator_ax::tree(&raw, &screen, options))
}

/// How a tree's points sit on the framebuffer.
#[napi]
pub fn device_platform_simulator_layout(raw: String, screen: String) -> napi::Result<String> {
    let raw = json(&raw)?;
    let screen: simulator_ax::Screen = parse(&screen)?;
    ace_json::ser::to_string(&simulator_ax::layout(&raw, &screen))
        .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))
}

/// The node a Simulator ref names, or the stale-ref refusal.
#[napi]
pub fn device_platform_simulator_target(tree: String, reference: String) -> napi::Result<String> {
    let tree: android_ui::Tree = parse(&tree)?;
    answered(|| simulator_ax::target(&tree, &reference))
}

/// The input a semantic action on a Simulator node becomes.
#[napi]
pub fn device_platform_simulator_action_input(
    node: String,
    action: String,
    turn: u16,
) -> napi::Result<String> {
    let node: android_ui::Node = parse(&node)?;
    let action: ActOptions = parse(&action)?;
    let turn = turn_of(turn)?;
    answered(|| simulator_ax::action_input(&node, &action.action, action.value.as_ref(), turn))
}

/// One finger message as the step Xcode's `--sim-touch` helper takes.
#[napi]
pub fn device_platform_digitizer_step(message: String, target: u32) -> napi::Result<String> {
    let message: fingers::WireMessage = parse(&message)?;
    answered(|| fingers::digitizer_step(&message, target))
}

/// What a Simulator key does: press a serve-sim message, type a line, or refuse.
#[napi]
pub fn device_platform_key_action(key_name: String, orientation: String) -> napi::Result<String> {
    let key = key(&key_name)?;
    answered(|| {
        fingers::key_action(key, &orientation).map(|action| match action {
            fingers::KeyAction::Press(message) => Digits::Press { message },
            fingers::KeyAction::Type(text) => Digits::Type { text },
        })
    })
}

/// The action as the shell reads it: `{"kind":"press","message":…}` or `{"kind":"type","text":…}`.
#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Digits {
    Press { message: fingers::Message },
    Type { text: String },
}

/// A device point as serve-sim's normalized one, refused outside the current frame.
#[napi]
pub fn device_platform_normalized_point(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> napi::Result<String> {
    answered(|| fingers::normalized_point(x, y, width, height))
}

/// The line the UI helper answered, as `{"kind":"ready"}`, `{"kind":"answer","line":…}` or
/// `{"kind":"ignored"}`.
#[napi]
pub fn device_platform_helper_reply(line: String) -> String {
    let value = match helper::helper_reply(&line) {
        helper::HelperReply::Ready => ace_json::json!({"kind": "ready"}),
        helper::HelperReply::Answer(line) => ace_json::json!({"kind": "answer", "line": line}),
        helper::HelperReply::Ignored => ace_json::json!({"kind": "ignored"}),
    };
    value.to_json()
}

/// serve-sim's system-edge flag for a normalized point: 1 left, 2 top, 3 bottom, 4 right, 0 none.
#[napi]
pub fn device_platform_screen_edge(x: f64, y: f64) -> u32 {
    u32::from(fingers::screen_edge(x, y))
}

/// Whether a line answers the input marker, and whether the command succeeded.
#[napi]
pub fn device_platform_input_answer(line: String, marker: String) -> Option<bool> {
    helper::input_answer(&line, &marker)
}

/// One pasteboard command's plan: its arguments, byte cap and deadline.
#[napi]
pub fn device_platform_pasteboard_plan(verb: String, udid: String) -> napi::Result<String> {
    ace_json::ser::to_string(&clipboard::pasteboard_plan(&verb, &udid))
        .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))
}

/// One `simctl` pasteboard command's plan and the `/ax` read's bounds.
#[napi]
pub fn device_platform_simulator_ax_limits() -> napi::Result<String> {
    ace_json::ser::to_string(&ace_devices::platform::simulator_ui::limits())
        .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))
}

/// One event of the scrcpy clipboard: the machine's state in and out, with what the shell does.
#[napi]
pub fn device_platform_scrcpy_clipboard_step(
    state: Option<String>,
    event: String,
) -> napi::Result<String> {
    let mut machine = match state {
        Some(text) => parse::<ace_devices::platform::scrcpy::clipboard::ScrcpyClipboard>(&text)?,
        None => ace_devices::platform::scrcpy::clipboard::ScrcpyClipboard::new(),
    };
    let event: ace_devices::platform::scrcpy::clipboard::ClipboardEvent = parse(&event)?;
    let out = machine.step(event);
    answered(|| {
        Ok(ClipboardStep {
            state: machine,
            out,
        })
    })
}

/// The clipboard's carried state and the shell's work, in the schema's field order.
#[derive(serde::Serialize)]
struct ClipboardStep {
    state: ace_devices::platform::scrcpy::clipboard::ScrcpyClipboard,
    out: Vec<ace_devices::platform::scrcpy::clipboard::ClipboardOut>,
}

/// One step of the held scrcpy pointers: applying an input, or lifting every held finger.
#[napi]
pub fn device_platform_held_pointers_step(
    state: Option<String>,
    input: Option<String>,
) -> napi::Result<String> {
    let mut pointers = match state {
        Some(text) => parse::<scrcpy_input::HeldPointers>(&text)?,
        None => scrcpy_input::HeldPointers::new(),
    };
    let released = match input {
        Some(text) => {
            let input: ace_devices::platform::device_input::DeviceInput = parse(&text)?;
            pointers.apply(&input);
            Vec::new()
        }
        None => pointers.release(),
    };
    ace_json::ser::to_string(&PointersStep {
        state: pointers,
        released,
    })
    .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))
}

/// The pointers' carried state and the inputs that lift what is left.
#[derive(serde::Serialize)]
struct PointersStep {
    state: scrcpy_input::HeldPointers,
    released: Vec<ace_devices::platform::device_input::DeviceInput>,
}

/// One socket chunk through scrcpy's device-message reader: the messages it completed.
#[napi]
pub fn device_platform_scrcpy_device_reader_step(
    state: Option<String>,
    chunk: String,
) -> napi::Result<String> {
    let mut reader = match state {
        Some(text) => {
            let state: scrcpy_protocol::ReaderState = parse(&text)?;
            scrcpy_protocol::DeviceMessageReader::from_state(&state)
                .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))?
        }
        None => scrcpy_protocol::DeviceMessageReader::new(),
    };
    let bytes = hex_chunk(&chunk)?;
    let pushed = reader.push(&bytes);
    answered(|| {
        Ok(ReaderStep {
            state: reader.state(),
            messages: pushed?,
        })
    })
}

/// The reader's carried state and the messages one chunk completed.
#[derive(serde::Serialize)]
struct ReaderStep {
    state: scrcpy_protocol::ReaderState,
    messages: Vec<scrcpy_protocol::DeviceMessage>,
}

/// A socket chunk as hex, as the shell writes it.
fn hex_chunk(chunk: &str) -> napi::Result<Vec<u8>> {
    let bytes = chunk.as_bytes();
    if !bytes.len().is_multiple_of(2) {
        return Err(napi::Error::from_reason(
            "ace-devices: a reader chunk is not hex",
        ));
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut index = 0;
    while index < bytes.len() {
        let pair = std::str::from_utf8(&bytes[index..index + 2])
            .map_err(|_| napi::Error::from_reason("ace-devices: a reader chunk is not hex"))?;
        out.push(
            u8::from_str_radix(pair, 16)
                .map_err(|_| napi::Error::from_reason("ace-devices: a reader chunk is not hex"))?,
        );
        index += 2;
    }
    Ok(out)
}

/// The Simulator's typing arguments, as `type --stdin -d <device>`.
#[napi]
pub fn device_platform_typing_args(device: String) -> Vec<String> {
    fingers::typing_args(&device)
}

/// The input shell's pinned arguments and the line one command writes.
#[napi]
pub fn device_platform_input_shell(serial: String, command: String, sequence: i64) -> Vec<String> {
    let marker = helper::input_marker(sequence.max(0) as u64);
    vec![
        helper::input_shell_args(&serial).join("\u{1}"),
        helper::input_line(&command, &marker),
        marker,
    ]
}

/// The Android UI helper's pinned arguments.
#[napi]
pub fn device_platform_ui_helper_args(serial: String) -> Vec<String> {
    helper::ui_helper_args(&serial)
}

/// The XML an `OK ` answer carries, or the refusal an `ERR ` answer names.
#[napi]
pub fn device_platform_ui_helper_tree(reply: String) -> napi::Result<String> {
    answered(|| helper::helper_tree(&reply))
}
