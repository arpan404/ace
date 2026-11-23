// SPDX-License-Identifier: Apache-2.0
//! The `sim act` argument table: actions, targets and whole numbers. Ports the action half
//! of `apps/daemon/src/cli/sim-args.ts` exactly.

use cli_out::{ErrorCode, Failure, Flags};

pub(super) fn usage(message: impl Into<String>) -> Failure<'static> {
    Failure::usage(message.into()).with_code(ErrorCode::BadArgument)
}

pub(super) fn is_ref(word: &str) -> bool {
    let rest = word.strip_prefix('@').unwrap_or(word);
    rest.starts_with('e') && rest.len() > 1 && rest[1..].bytes().all(|b| b.is_ascii_digit())
}

/// Whole numbers stay numbers so the tool's schema, not the CLI, judges them.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
pub(super) fn number(word: &str, name: &str) -> Result<serde_json::Number, Failure<'static>> {
    let bytes = word.as_bytes();
    let digits = word.strip_prefix('-').unwrap_or(word);
    let valid =
        !bytes.is_empty() && !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit());
    if !valid {
        return Err(usage(format!(
            "{name} must be a whole number. See ace help sim act."
        )));
    }
    if let Ok(parsed) = word.parse::<i64>() {
        return Ok(serde_json::Number::from(parsed));
    }
    // Overflow of i64: `Number()` still reads it as a float, so do the same.
    let parsed = cli_parse::js_number(word);
    if let Some(float) = serde_json::Number::from_f64(parsed) {
        return Ok(float);
    }
    Err(usage(format!(
        "{name} must be a whole number. See ace help sim act."
    )))
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
pub(super) fn optional_number(
    flags: &Flags<'_>,
    name: &str,
) -> Result<Option<serde_json::Number>, Failure<'static>> {
    let Some(value) = flags.value(name) else {
        return Ok(None);
    };
    number(value, &format!("--{name}")).map(Some)
}

/// `--value` for ui: JSON for scroll deltas and booleans, otherwise the text itself.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
pub(super) fn ui_value(raw: Option<&str>) -> Result<Option<serde_json::Value>, Failure<'static>> {
    let Some(text) = raw else {
        return Ok(None);
    };
    if text == "true" || text == "false" || text.starts_with('{') {
        match serde_json::from_str::<serde_json::Value>(text) {
            Ok(parsed) => Ok(Some(parsed)),
            Err(_) => Err(usage("--value must be valid JSON when it starts with {")),
        }
    } else {
        Ok(Some(serde_json::Value::String(text.to_owned())))
    }
}

pub(super) fn defined(entries: Vec<(String, Option<serde_json::Value>)>) -> serde_json::Value {
    let map: serde_json::Map<String, serde_json::Value> = entries
        .into_iter()
        .filter_map(|(key, value)| value.map(|value| (key, value)))
        .collect();
    serde_json::Value::Object(map)
}

/// `@e3` or `X Y`, the two ways tap and `long_press` name their target.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
pub(super) fn target(
    words: &[&str],
    action: &str,
) -> Result<Vec<(String, serde_json::Value)>, Failure<'static>> {
    if words.len() == 1 && is_ref(words[0]) {
        return Ok(vec![(
            "ref".to_owned(),
            serde_json::Value::String(words[0].to_owned()),
        )]);
    }
    if words.len() == 2 {
        return Ok(vec![
            (
                "x".to_owned(),
                serde_json::Value::Number(number(words[0], "X")?),
            ),
            (
                "y".to_owned(),
                serde_json::Value::Number(number(words[1], "Y")?),
            ),
        ]);
    }
    Err(usage(format!(
        "{action} takes @ref or X Y. See ace help sim act."
    )))
}

/// The `sim_act` arguments for `ace sim act SIM ACTION …`.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
#[allow(
    clippy::too_many_lines,
    reason = "one action table, mirroring sim-args.ts in order"
)]
pub(super) fn act_args(
    sim_id: &str,
    action: &str,
    words: &[&str],
    flags: &Flags<'_>,
) -> Result<serde_json::Value, Failure<'static>> {
    const UI_ACTIONS: &[&str] = &[
        "press",
        "focus",
        "setValue",
        "scroll",
        "expand",
        "select",
        "performSecondaryAction",
        "selectText",
    ];
    if UI_ACTIONS.contains(&action) {
        if words.len() != 1 || !is_ref(words[0]) {
            return Err(usage(format!(
                "{action} takes one @ref. See ace help sim act."
            )));
        }
        return Ok(defined(vec![
            (
                "simId".to_owned(),
                Some(serde_json::Value::String(sim_id.to_owned())),
            ),
            (
                "action".to_owned(),
                Some(serde_json::Value::String("ui".to_owned())),
            ),
            (
                "ref".to_owned(),
                Some(serde_json::Value::String(words[0].to_owned())),
            ),
            (
                "uiAction".to_owned(),
                Some(serde_json::Value::String(action.to_owned())),
            ),
            ("value".to_owned(), ui_value(flags.value("value"))?),
            (
                "name".to_owned(),
                flags
                    .value("name")
                    .map(|name| serde_json::Value::String(name.to_owned())),
            ),
        ]));
    }
    let duration = optional_number(flags, "duration")?;
    let with_duration = |mut entries: Vec<(String, serde_json::Value)>| -> serde_json::Value {
        if let Some(ms) = &duration {
            entries.push((
                "durationMs".to_owned(),
                serde_json::Value::Number(ms.clone()),
            ));
        }
        serde_json::Value::Object(entries.into_iter().collect())
    };
    let base = |field: Option<(&str, &str)>| -> Vec<(String, serde_json::Value)> {
        let mut entries = vec![
            (
                "simId".to_owned(),
                serde_json::Value::String(sim_id.to_owned()),
            ),
            (
                "action".to_owned(),
                serde_json::Value::String(action.to_owned()),
            ),
        ];
        if let Some((key, value)) = field {
            entries.push((key.to_owned(), serde_json::Value::String(value.to_owned())));
        }
        entries
    };
    match action {
        "tap" | "long_press" => Ok(with_duration({
            let mut entries = base(None);
            for (key, value) in target(words, action)? {
                entries.push((key, value));
            }
            entries
        })),
        "swipe" => {
            if words.len() != 4 {
                return Err(usage("swipe takes X Y TOX TOY."));
            }
            let points: Vec<serde_json::Number> = words
                .iter()
                .map(|word| number(word, "swipe point"))
                .collect::<Result<Vec<_>, _>>()?;
            let mut entries = base(None);
            for (key, point) in ["x", "y", "toX", "toY"].into_iter().zip(points) {
                entries.push((key.to_owned(), serde_json::Value::Number(point)));
            }
            Ok(with_duration(entries))
        }
        "type" => {
            let named = words.len() == 2 && is_ref(words[0]);
            let plain = words.len() == 1;
            if named {
                let mut entries = base(Some(("ref", words[0])));
                entries.push((
                    "text".to_owned(),
                    serde_json::Value::String(words[1].to_owned()),
                ));
                return Ok(with_duration(entries));
            }
            if plain {
                let entries = base(Some(("text", words[0])));
                return Ok(with_duration(entries));
            }
            Err(usage("type takes [@ref] TEXT."))
        }
        "key" | "open_app" | "open_url" | "install" | "clipboard_set" | "posture" => {
            if words.len() != 1 {
                let field = match action {
                    "key" => "key",
                    "open_app" => "appId",
                    "open_url" => "url",
                    "install" => "path",
                    "clipboard_set" => "text",
                    _ => "posture",
                };
                return Err(usage(format!("{action} takes one {field}.")));
            }
            let field = match action {
                "key" => "key",
                "open_app" => "appId",
                "open_url" => "url",
                "install" => "path",
                "clipboard_set" => "text",
                _ => "posture",
            };
            Ok(with_duration(base(Some((field, words[0])))))
        }
        "record_start" | "record_stop" | "clipboard_get" => {
            if !words.is_empty() {
                return Err(usage(format!("{action} takes no arguments.")));
            }
            Ok(serde_json::Value::Object(base(None).into_iter().collect()))
        }
        _ => Err(usage(format!(
            "Unknown action {action}. See ace help sim act."
        ))),
    }
}
