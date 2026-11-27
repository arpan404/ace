// SPDX-License-Identifier: Apache-2.0
//! Typed decoding of the `sim_*` tools' arguments (`packages/devices/src/sim-schemas.ts`).
//!
//! The Zod schemas are replaced here: the same fields, the same bounds (code points
//! for strings, integers for points and durations), the same defaults, and the same
//! public `invalid_arguments` issues — a path and what the schema expected, never a
//! value the agent sent.

use ace_json::{JsString, Value};

use crate::service::sim_refs::is_ref;

/// A string's cap counted as zodiac counts it: code points, and one for each
/// unpaired surrogate (`JsString::len_code_points`).
fn code_points(text: &JsString) -> usize {
    text.len_code_points()
}

/// One field's refusal, as `argumentIssues` renders it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    /// `simId`, `ref`, or `(arguments)` for the root.
    pub path: String,
    /// What the schema expected, never the value that was sent.
    pub expected: String,
}

/// The issues one argument set raised, and whether they are about its shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArgumentError {
    pub issues: Vec<Issue>,
    /// A field or variant that does not exist: the caller points the agent at the
    /// tool's schema (`tools_find <tool> returns its schema.`).
    pub shape: bool,
    /// A wrong type or an unknown enum value. Zod stops at one of these before its
    /// refinements run, so the per-action rules must not add a second opinion.
    aborted: bool,
}

impl ArgumentError {
    fn new() -> Self {
        Self {
            issues: Vec::new(),
            shape: false,
            aborted: false,
        }
    }

    fn issue(&mut self, path: &str, expected: impl Into<String>) {
        self.issues.push(Issue {
            path: path.to_owned(),
            expected: expected.into(),
        });
    }

    fn unknown(&mut self, path: &str, allowed: &[&str]) {
        self.shape = true;
        if allowed.is_empty() {
            self.issue(
                path,
                "no such field: remove it, or check the spelling against the schema",
            );
            return;
        }
        self.issue(
            path,
            format!("no such field; fields here: {}", allowed.join(", ")),
        );
    }

    /// The issues `argumentIssues` keeps at most.
    fn capped(mut self) -> Self {
        self.issues.truncate(16);
        self
    }
}

/// One `sim_*` tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SimTool {
    List,
    Start,
    Stop,
    Ui,
    Act,
    Screenshot,
    Logs,
}

impl SimTool {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::List => "sim_list",
            Self::Start => "sim_start",
            Self::Stop => "sim_stop",
            Self::Ui => "sim_ui",
            Self::Act => "sim_act",
            Self::Screenshot => "sim_screenshot",
            Self::Logs => "sim_logs",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "sim_list" => Self::List,
            "sim_start" => Self::Start,
            "sim_stop" => Self::Stop,
            "sim_ui" => Self::Ui,
            "sim_act" => Self::Act,
            "sim_screenshot" => Self::Screenshot,
            "sim_logs" => Self::Logs,
            _ => return None,
        })
    }
}

/// `sim_start`'s arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartArgs {
    pub sim_id: String,
    pub boot: bool,
}

/// `sim_stop`'s and `sim_screenshot`'s one field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceArgs {
    pub sim_id: String,
}

/// `sim_ui`'s read, with zod's defaults (`uiReadShape`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UiArgs {
    pub sim_id: String,
    pub role: Option<String>,
    pub name: Option<String>,
    pub text: Option<String>,
    pub limit: u32,
    pub max_depth: u32,
    pub max_nodes: u32,
}

/// `sim_logs`' arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogsArgs {
    pub sim_id: String,
    pub limit: u32,
}

/// `sim_act`'s action, as the schema's enum spells it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActAction {
    Ui,
    Tap,
    LongPress,
    Swipe,
    Type,
    Key,
    OpenApp,
    OpenUrl,
    Install,
    RecordStart,
    RecordStop,
    ClipboardGet,
    ClipboardSet,
    Posture,
}

impl ActAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ui => "ui",
            Self::Tap => "tap",
            Self::LongPress => "long_press",
            Self::Swipe => "swipe",
            Self::Type => "type",
            Self::Key => "key",
            Self::OpenApp => "open_app",
            Self::OpenUrl => "open_url",
            Self::Install => "install",
            Self::RecordStart => "record_start",
            Self::RecordStop => "record_stop",
            Self::ClipboardGet => "clipboard_get",
            Self::ClipboardSet => "clipboard_set",
            Self::Posture => "posture",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "ui" => Self::Ui,
            "tap" => Self::Tap,
            "long_press" => Self::LongPress,
            "swipe" => Self::Swipe,
            "type" => Self::Type,
            "key" => Self::Key,
            "open_app" => Self::OpenApp,
            "open_url" => Self::OpenUrl,
            "install" => Self::Install,
            "record_start" => Self::RecordStart,
            "record_stop" => Self::RecordStop,
            "clipboard_get" => Self::ClipboardGet,
            "clipboard_set" => Self::ClipboardSet,
            "posture" => Self::Posture,
            _ => return None,
        })
    }

    const ALL: [&'static str; 14] = [
        "ui",
        "tap",
        "long_press",
        "swipe",
        "type",
        "key",
        "open_app",
        "open_url",
        "install",
        "record_start",
        "record_stop",
        "clipboard_get",
        "clipboard_set",
        "posture",
    ];
}

/// `ScreenUIAction`: the actions an element may take.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiAction {
    Press,
    Focus,
    SetValue,
    Scroll,
    Expand,
    Select,
    PerformSecondaryAction,
    SelectText,
}

impl UiAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Press => "press",
            Self::Focus => "focus",
            Self::SetValue => "setValue",
            Self::Scroll => "scroll",
            Self::Expand => "expand",
            Self::Select => "select",
            Self::PerformSecondaryAction => "performSecondaryAction",
            Self::SelectText => "selectText",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "press" => Self::Press,
            "focus" => Self::Focus,
            "setValue" => Self::SetValue,
            "scroll" => Self::Scroll,
            "expand" => Self::Expand,
            "select" => Self::Select,
            "performSecondaryAction" => Self::PerformSecondaryAction,
            "selectText" => Self::SelectText,
            _ => return None,
        })
    }

    const ALL: [&'static str; 8] = [
        "press",
        "focus",
        "setValue",
        "scroll",
        "expand",
        "select",
        "performSecondaryAction",
        "selectText",
    ];
}

/// A device key (`DeviceInput`'s `key` enum).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActKey {
    Home,
    Back,
    Rotate,
    Enter,
    Power,
    Recents,
    VolumeUp,
    VolumeDown,
    Action,
    Side,
    Keyboard,
}

impl ActKey {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Home => "home",
            Self::Back => "back",
            Self::Rotate => "rotate",
            Self::Enter => "enter",
            Self::Power => "power",
            Self::Recents => "recents",
            Self::VolumeUp => "volumeUp",
            Self::VolumeDown => "volumeDown",
            Self::Action => "action",
            Self::Side => "side",
            Self::Keyboard => "keyboard",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "home" => Self::Home,
            "back" => Self::Back,
            "rotate" => Self::Rotate,
            "enter" => Self::Enter,
            "power" => Self::Power,
            "recents" => Self::Recents,
            "volumeUp" => Self::VolumeUp,
            "volumeDown" => Self::VolumeDown,
            "action" => Self::Action,
            "side" => Self::Side,
            "keyboard" => Self::Keyboard,
            _ => return None,
        })
    }

    const ALL: [&'static str; 11] = [
        "home",
        "back",
        "rotate",
        "enter",
        "power",
        "recents",
        "volumeUp",
        "volumeDown",
        "action",
        "side",
        "keyboard",
    ];
}

/// A foldable device's posture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActPosture {
    Closed,
    PartiallyOpen,
    Open,
}

impl ActPosture {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Closed => "closed",
            Self::PartiallyOpen => "partiallyOpen",
            Self::Open => "open",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "closed" => Self::Closed,
            "partiallyOpen" => Self::PartiallyOpen,
            "open" => Self::Open,
            _ => return None,
        })
    }

    const ALL: [&'static str; 3] = ["closed", "partiallyOpen", "open"];
}

/// A UI action's value: text, a flag, or a scroll.
#[derive(Debug, Clone, PartialEq)]
pub enum ActValue {
    Text(String),
    Flag(bool),
    Scroll { dx: i64, dy: i64 },
}

/// `sim_act`'s arguments.
#[derive(Debug, Clone, PartialEq)]
pub struct ActArgs {
    pub sim_id: String,
    pub action: ActAction,
    pub reference: Option<String>,
    pub ui_action: Option<UiAction>,
    pub value: Option<ActValue>,
    pub name: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub to_x: Option<f64>,
    pub to_y: Option<f64>,
    pub duration_ms: Option<f64>,
    pub text: Option<String>,
    pub key: Option<ActKey>,
    pub app_id: Option<String>,
    pub url: Option<String>,
    pub path: Option<String>,
    pub posture: Option<ActPosture>,
}

/// One decoded argument set.
#[derive(Debug, Clone, PartialEq)]
pub enum Args {
    List,
    Start(StartArgs),
    Stop(DeviceArgs),
    Ui(UiArgs),
    Act(ActArgs),
    Screenshot(DeviceArgs),
    Logs(LogsArgs),
}

/// The fields each tool's strict object allows, for an unknown key's message.
const LIST_FIELDS: &[&str] = &[];
const START_FIELDS: &[&str] = &["simId", "boot"];
const DEVICE_FIELDS: &[&str] = &["simId"];
const UI_FIELDS: &[&str] = &[
    "simId", "role", "name", "text", "limit", "maxDepth", "maxNodes",
];
const LOGS_FIELDS: &[&str] = &["simId", "limit"];
const ACT_FIELDS: &[&str] = &[
    "simId",
    "action",
    "ref",
    "uiAction",
    "value",
    "name",
    "x",
    "y",
    "toX",
    "toY",
    "durationMs",
    "text",
    "key",
    "appId",
    "url",
    "path",
    "posture",
];

/// `AppDeviceId`: `ios:` and a UUID, or `android:` and a name.
fn is_device_id(value: &str) -> bool {
    if let Some(rest) = value.strip_prefix("ios:") {
        return rest.len() == 36
            && rest
                .chars()
                .all(|char| char.is_ascii_hexdigit() || char == '-');
    }
    let Some(rest) = value.strip_prefix("android:") else {
        return false;
    };
    (1..=200).contains(&rest.chars().count())
        && rest
            .chars()
            .all(|char| char.is_ascii_alphanumeric() || matches!(char, '_' | '.' | '-'))
}

/// One strict object's fields, accumulating what the schema refuses.
struct Fields<'a> {
    object: &'a ace_json::Map,
    issues: ArgumentError,
}

impl<'a> Fields<'a> {
    fn new(value: &'a Value) -> Result<Self, ArgumentError> {
        let Some(object) = value.as_object() else {
            let mut issues = ArgumentError::new();
            issues.issue("(arguments)", "object");
            return Err(issues);
        };
        Ok(Self {
            object,
            issues: ArgumentError::new(),
        })
    }

    /// The field's value, when it was sent at all (a JSON `null` is a wrong type,
    /// not an absent field, as zod reads it).
    fn value(&mut self, key: &str) -> Option<&'a Value> {
        self.object.get(key)
    }

    fn missing(&mut self, key: &str, kind: &str) {
        self.issues.issue(key, format!("required {kind}, missing"));
        self.issues.aborted = true;
    }

    /// What a value of the wrong type does: zodiac reports, then stops its checks.
    fn wrong_type(&mut self, key: &str, expected: &str) {
        self.issues.issue(key, expected);
        self.issues.aborted = true;
    }

    fn string(&mut self, key: &str, min: usize, max: usize) -> Option<String> {
        match self.value(key) {
            None => None,
            Some(Value::String(text)) => {
                let count = code_points(text);
                if count < min {
                    self.issues.issue(key, format!("string >= {min} in length"));
                    return None;
                }
                if count > max {
                    self.issues.issue(key, format!("string <= {max} in length"));
                    return None;
                }
                // The carrier keeps a lone surrogate, so the value the agent sent
                // is the value the tool acts on.
                Some(text.to_rust().into_owned())
            }
            Some(_) => {
                self.wrong_type(key, "string");
                None
            }
        }
    }

    fn required_string(&mut self, key: &str, min: usize, max: usize) -> Option<String> {
        if self.object.get(key).is_none() {
            self.missing(key, "string");
            return None;
        }
        self.string(key, min, max)
    }

    fn integer(&mut self, key: &str, min: f64, max: f64) -> Option<f64> {
        let value = self.value(key)?;
        // `z.number()` refuses what JSON can carry but JavaScript's number cannot be:
        // a non-finite one. It is a wrong type, so the field stops there.
        let Some(number) = value.as_f64().filter(|number| number.is_finite()) else {
            self.wrong_type(key, "number");
            return None;
        };
        if number.fract() != 0.0 {
            self.wrong_type(key, "int");
            return None;
        }
        // `int()` is a safe integer: this bound continues to the field's own, as
        // zodiac reports both rather than stopping at the first.
        if let Some(expected) = safe_integer_issue(number) {
            self.issues.issue(key, expected);
        }
        if number < min {
            self.issues
                .issue(key, format!("number >= {}", render_number(min)));
            return None;
        }
        if number > max {
            self.issues
                .issue(key, format!("number <= {}", render_number(max)));
            return None;
        }
        Some(number)
    }

    fn boolean(&mut self, key: &str) -> Option<bool> {
        match self.value(key) {
            None => None,
            Some(Value::Bool(flag)) => Some(*flag),
            Some(_) => {
                self.wrong_type(key, "boolean");
                None
            }
        }
    }

    fn enum_str(&mut self, key: &str, allowed: &[&str]) -> Option<&'a str> {
        match self.value(key) {
            None => None,
            Some(Value::String(text)) => {
                let value = text.as_str();
                if allowed.contains(&value) {
                    Some(value)
                } else {
                    self.wrong_type(key, &one_of(allowed));
                    None
                }
            }
            // Zod's enum names its values for any other type too, not the type.
            Some(_) => {
                self.wrong_type(key, &one_of(allowed));
                None
            }
        }
    }

    fn required_enum(&mut self, key: &str, allowed: &[&str]) -> Option<&'a str> {
        if self.object.get(key).is_none() {
            self.wrong_type(key, &one_of(allowed));
            return None;
        }
        self.enum_str(key, allowed)
    }

    /// The strict object's unknown keys, in the order they were sent.
    fn unknown(&mut self, allowed: &[&str]) {
        for key in self.object.keys() {
            if !allowed.contains(&key.as_str()) {
                self.issues.unknown(path_segment(key), allowed);
            }
        }
    }

    fn finish(self) -> Result<(), ArgumentError> {
        if self.issues.issues.is_empty() {
            Ok(())
        } else {
            Err(self.issues.capped())
        }
    }
}

/// `render`'s path segment: a field name ace's schema could own
/// (`/^[\w$-]{1,64}$/`), never a key the agent chose. A dotted, empty, over-long
/// or surrogate-bearing key renders as `<field>`, as the TypeScript does.
fn path_segment(key: &JsString) -> &str {
    const PLACEHOLDER: &str = "<field>";
    let Some(text) = key.as_well_formed() else {
        return PLACEHOLDER;
    };
    let field_name = (1..=64).contains(&text.len())
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$' | b'-'));
    if field_name { text } else { PLACEHOLDER }
}

fn one_of(values: &[&str]) -> String {
    let quoted: Vec<String> = values
        .iter()
        .map(|value| ace_json::to_string(&Value::String(JsString::from(*value))))
        .collect();
    format!("one of {}", quoted.join(", "))
}

fn render_number(value: f64) -> String {
    ace_json::to_string(&Value::Number(value.into()))
}

/// `Number.MAX_SAFE_INTEGER` and its negative: Zod's `.int()` is a safe integer.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const MIN_SAFE_INTEGER: f64 = -9_007_199_254_740_991.0;

/// The safe-integer bound a number breaks, as `argumentIssues` renders it. Zod keeps
/// this check going to the field's own bound, so both issues are reported.
fn safe_integer_issue(number: f64) -> Option<&'static str> {
    if number > MAX_SAFE_INTEGER {
        Some("int <= 9007199254740991")
    } else if number < MIN_SAFE_INTEGER {
        Some("int >= -9007199254740991")
    } else {
        None
    }
}

/// Decode one tool's arguments exactly as its schema would.
pub fn decode(tool: SimTool, raw: &Value) -> Result<Args, ArgumentError> {
    match tool {
        SimTool::List => {
            let mut fields = Fields::new(raw)?;
            fields.unknown(LIST_FIELDS);
            fields.finish()?;
            Ok(Args::List)
        }
        SimTool::Start => {
            let mut fields = Fields::new(raw)?;
            let sim_id = device_id(&mut fields, raw);
            let boot = fields.boolean("boot");
            fields.unknown(START_FIELDS);
            fields.finish()?;
            Ok(Args::Start(StartArgs {
                sim_id: sim_id.unwrap_or_default(),
                boot: boot.unwrap_or(true),
            }))
        }
        SimTool::Stop | SimTool::Screenshot => {
            let mut fields = Fields::new(raw)?;
            let sim_id = device_id(&mut fields, raw);
            fields.unknown(DEVICE_FIELDS);
            fields.finish()?;
            Ok(if tool == SimTool::Stop {
                Args::Stop(DeviceArgs {
                    sim_id: sim_id.unwrap_or_default(),
                })
            } else {
                Args::Screenshot(DeviceArgs {
                    sim_id: sim_id.unwrap_or_default(),
                })
            })
        }
        SimTool::Ui => {
            let mut fields = Fields::new(raw)?;
            let sim_id = device_id(&mut fields, raw);
            let role = fields.string("role", 1, 128);
            let name = fields.string("name", 1, 256);
            let text = fields.string("text", 1, 512);
            let limit = fields.integer("limit", 1.0, 64.0);
            let max_depth = fields.integer("maxDepth", 0.0, 16.0);
            let max_nodes = fields.integer("maxNodes", 1.0, 512.0);
            fields.unknown(UI_FIELDS);
            fields.finish()?;
            Ok(Args::Ui(UiArgs {
                sim_id: sim_id.unwrap_or_default(),
                role,
                name,
                text,
                limit: limit.unwrap_or(16.0) as u32,
                max_depth: max_depth.unwrap_or(8.0) as u32,
                max_nodes: max_nodes.unwrap_or(128.0) as u32,
            }))
        }
        SimTool::Logs => {
            let mut fields = Fields::new(raw)?;
            let sim_id = device_id(&mut fields, raw);
            let limit = fields.integer("limit", 1.0, 256.0);
            fields.unknown(LOGS_FIELDS);
            fields.finish()?;
            Ok(Args::Logs(LogsArgs {
                sim_id: sim_id.unwrap_or_default(),
                limit: limit.unwrap_or(100.0) as u32,
            }))
        }
        SimTool::Act => decode_act(raw).map(Args::Act),
    }
}

/// `AppDeviceId`'s pattern, as the issue names it.
const DEVICE_ID_PATTERN: &str = r"/^(?:ios:[\da-fA-F-]{36}|android:[\w.-]{1,200})$/";
/// `simRefPattern`, as the issue names it.
const REF_PATTERN: &str = r"/^@?e[1-9]\d{0,6}$/";

/// `AppDeviceId`: the string bound, then its pattern, at the field's own position.
fn device_id(fields: &mut Fields<'_>, raw: &Value) -> Option<String> {
    let sim_id = fields.required_string("simId", 0, 256);
    if let Some(value) = raw.get("simId").and_then(Value::as_str)
        && !is_device_id(value)
    {
        fields
            .issues
            .issue("simId", format!("a string matching {DEVICE_ID_PATTERN}"));
    }
    sim_id
}

/// `SimActFields` and its two refinements, in zod's order: the object, then
/// `perAction`, then `simActPoint`.
fn decode_act(raw: &Value) -> Result<ActArgs, ArgumentError> {
    let mut fields = Fields::new(raw)?;
    let sim_id = device_id(&mut fields, raw);
    let action = fields
        .required_enum("action", &ActAction::ALL)
        .and_then(ActAction::parse);
    let reference = fields.string("ref", 0, usize::MAX);
    if let Some(value) = raw.get("ref").and_then(Value::as_str)
        && !is_ref(value)
    {
        fields
            .issues
            .issue("ref", format!("a string matching {REF_PATTERN}"));
    }
    let ui_action = fields
        .enum_str("uiAction", &UiAction::ALL)
        .and_then(UiAction::parse);
    let value = act_value(&mut fields);
    let name = fields.string("name", 1, 256);
    let x = fields.integer("x", 0.0, 16_384.0);
    let y = fields.integer("y", 0.0, 16_384.0);
    let to_x = fields.integer("toX", 0.0, 16_384.0);
    let to_y = fields.integer("toY", 0.0, 16_384.0);
    let duration_ms = fields.integer("durationMs", 1.0, 10_000.0);
    let text = fields.string("text", 0, 4_096);
    let key = fields.enum_str("key", &ActKey::ALL).and_then(ActKey::parse);
    let app_id = fields.string("appId", 1, 256);
    let url = fields.string("url", 1, 4_096);
    let path = fields.string("path", 1, 4_096);
    let posture = fields
        .enum_str("posture", &ActPosture::ALL)
        .and_then(ActPosture::parse);
    fields.unknown(ACT_FIELDS);

    // `perAction`, then `simActPoint`, only for an action the enum accepted and
    // only while the object parse has not aborted on a wrong type or variant.
    if let Some(action) = action
        && !fields.issues.aborted
    {
        per_action(&mut fields, action, raw);
        point_rule(&mut fields, action, raw);
    }
    fields.finish()?;
    Ok(ActArgs {
        sim_id: sim_id.unwrap_or_default(),
        action: action.unwrap_or(ActAction::Tap),
        reference,
        ui_action,
        value,
        name,
        x,
        y,
        to_x,
        to_y,
        duration_ms,
        text,
        key,
        app_id,
        url,
        path,
        posture,
    })
}

/// `ScreenUIActOptions.shape.value`: text, a flag, or a scroll with its defaults.
///
/// The scroll is a union branch: a field that is not a number (or not an integer)
/// makes the whole union fail generically, while a value merely out of range keeps
/// its own `too_big` / `too_small` issue at `value.dx` or `value.dy`.
fn act_value(fields: &mut Fields<'_>) -> Option<ActValue> {
    let value = fields.value("value")?;
    match value {
        Value::String(text) => {
            if code_points(text) > 4_096 {
                fields.issues.issue("value", "string <= 4096 in length");
            }
            Some(ActValue::Text(text.to_rust().into_owned()))
        }
        Value::Bool(flag) => Some(ActValue::Flag(*flag)),
        Value::Object(object) => {
            let mut dx = 0.0;
            let mut dy = 0.0;
            let mut ranges: Vec<(&str, String)> = Vec::new();
            let mut aborted = false;
            for (key, target) in [("dx", &mut dx), ("dy", &mut dy)] {
                let Some(raw) = object.get(key) else {
                    continue;
                };
                let Some(number) = raw
                    .as_f64()
                    .filter(|number| number.is_finite() && number.fract() == 0.0)
                else {
                    aborted = true;
                    continue;
                };
                // The safe bound first, then the offset's own: Zod reports both.
                let mut refused = false;
                if let Some(expected) = safe_integer_issue(number) {
                    ranges.push((key, String::from(expected)));
                    refused = true;
                }
                if number < -1_000.0 {
                    ranges.push((key, String::from("number >= -1000")));
                    refused = true;
                } else if number > 1_000.0 {
                    ranges.push((key, String::from("number <= 1000")));
                    refused = true;
                }
                if !refused {
                    *target = number;
                }
            }
            if aborted {
                union_failure(fields, "one of the documented shapes for this field");
                return None;
            }
            for (key, expected) in ranges {
                fields.issues.issue(&format!("value.{key}"), expected);
            }
            Some(ActValue::Scroll {
                dx: dx as i64,
                dy: dy as i64,
            })
        }
        _ => {
            union_failure(fields, "string or boolean or object");
            None
        }
    }
}

/// The union's own refusal: the three branch types, or the documented shapes when
/// the object branch itself failed. Either way it is a shape issue.
fn union_failure(fields: &mut Fields<'_>, expected: &str) {
    fields.issues.issue("value", expected);
    fields.issues.shape = true;
    fields.issues.aborted = true;
}

/// `perAction`: the fields each action requires and allows.
fn per_action(fields: &mut Fields<'_>, action: ActAction, raw: &Value) {
    let Some(rule) = crate::service::sim_schemas::action_rule(action.as_str()) else {
        return;
    };
    let sent = |key: &str| raw.get(key).is_some_and(|value| !value.is_null());
    for field in rule.required {
        if !sent(field) {
            fields.issues.issue(
                field,
                format!("Required when action is {}", action.as_str()),
            );
        }
    }
    // The schema's fields, in its order: an unused one is named by the schema, not by
    // the order the agent sent its keys in. Unknown fields are dropped by the strict
    // object, so zod's refinement never sees them and they are not "not used" as well.
    for &key in ACT_FIELDS {
        if key == "action" || !sent(key) || rule.allowed.contains(&key) {
            continue;
        }
        fields
            .issues
            .issue(key, format!("Not used when action is {}", action.as_str()));
    }
}

/// `simActPoint`: a tap or a long press needs a ref or both coordinates, never both.
fn point_rule(fields: &mut Fields<'_>, action: ActAction, raw: &Value) {
    let has = |key: &str| raw.get(key).is_some_and(|value| !value.is_null());
    if let Some(message) =
        crate::service::sim_schemas::point_issue(action.as_str(), has("ref"), has("x"), has("y"))
    {
        fields.issues.issue("ref", message);
    }
}

#[cfg(test)]
mod tests;
