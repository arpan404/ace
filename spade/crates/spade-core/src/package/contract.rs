//! A package's contracts (ADR 0200 §7): typed calls other agents of the person may make to its
//! bot. Each has a name, a one-line summary, an input and an output schema in the bounded subset
//! of [`crate::schema`], the effects a call may use (a subset of what the package declares), and
//! examples, which the checks and tests use. The schemas live in `bot.json` itself, so the signed
//! manifest's `bot.json` carries them. The matching reader is `readContracts` in
//! `@ace/marketplace`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::effect::{self, Effect};
use crate::schema::{self, Schema};

/// The most contracts one package publishes, and examples one contract carries.
pub const MOST_CONTRACTS: usize = 16;
pub const MOST_EXAMPLES: usize = 8;
/// A call's input and a return's output, as JSON.
pub const INPUT_BYTES: usize = 64 * 1024;
pub const OUTPUT_BYTES: usize = 256 * 1024;
pub const SUMMARY_CHARS: usize = 200;

/// One example call, and what it answers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Example {
    pub input: Value,
    pub output: Value,
}

/// One contract, read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Contract {
    /// `cheapest_fare`: lower-case words joined by `_`, the name callers use.
    pub name: String,
    pub summary: String,
    /// The input's and the output's schemas, as written (each reads with [`schema::read`]).
    pub input: Value,
    pub output: Value,
    /// The effects a call's turn may use, beyond reading and the bot's own writes.
    #[serde(default)]
    pub effects: Vec<Effect>,
    #[serde(default)]
    pub examples: Vec<Example>,
}

impl Contract {
    pub fn input_schema(&self) -> Option<Schema> {
        schema::read(&self.input, "input").ok()
    }

    pub fn output_schema(&self) -> Option<Schema> {
        schema::read(&self.output, "output").ok()
    }

    /// The effects the ceiling holds a call's turn to.
    pub fn allows(&self) -> effect::ceiling::Effects {
        self.effects.iter().copied().collect()
    }

    /// Every way `input` doesn't fit, as lines; `None` when it fits.
    pub fn misfit_input(&self, input: &Value) -> Option<Vec<String>> {
        misfit(&self.input, input, "input", INPUT_BYTES, Schema::check)
    }

    /// Every way `output` doesn't fit, as lines; `None` when it fits. The callee's check: its
    /// output has only the fields its schema names.
    pub fn misfit_output(&self, output: &Value) -> Option<Vec<String>> {
        misfit(&self.output, output, "output", OUTPUT_BYTES, Schema::check)
    }

    /// The caller's check of an output it reads: as [`Contract::misfit_output`], except a field
    /// this schema doesn't name passes. The callee may run a newer version that adds optional
    /// output fields, a change the market signs as compatible (ADR 0200 §7).
    pub fn misfit_output_read(&self, output: &Value) -> Option<Vec<String>> {
        misfit(
            &self.output,
            output,
            "output",
            OUTPUT_BYTES,
            Schema::check_reading,
        )
    }
}

fn misfit(
    schema: &Value,
    value: &Value,
    at: &str,
    most: usize,
    check: fn(&Schema, &Value, &str) -> Vec<schema::Misfit>,
) -> Option<Vec<String>> {
    if value.to_string().len() > most {
        return Some(vec![format!("{at} is longer than {} KiB", most / 1024)]);
    }
    let Ok(schema) = schema::read(schema, at) else {
        return Some(vec![format!("{at}'s schema doesn't read")]);
    };
    let misfits = check(&schema, value, at);
    (!misfits.is_empty()).then(|| misfits.iter().map(ToString::to_string).collect())
}

/// Whether `name` names a contract: 1 to 64 of `a-z`, `0-9` and `_`, starting with a letter.
pub fn named(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name.starts_with(|c: char| c.is_ascii_lowercase())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// Reads `contracts`; `declared` is every effect word the package declares. Problems go to `out`.
pub fn read(value: Option<&Value>, declared: &[Effect], out: &mut Vec<String>) -> Vec<Contract> {
    let items = match value {
        None => return Vec::new(),
        Some(Value::Array(items)) if items.len() <= MOST_CONTRACTS => items,
        Some(_) => {
            out.push(format!("contracts is a list of at most {MOST_CONTRACTS}"));
            return Vec::new();
        }
    };
    let mut contracts: Vec<Contract> = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let at = format!("contracts[{i}]");
        if let Some(one) = contract(item, &at, declared, out) {
            if contracts.iter().any(|c| c.name == one.name) {
                out.push(format!("{at}: each contract has a name of its own"));
            }
            contracts.push(one);
        }
    }
    contracts
}

const FIELDS: [&str; 6] = ["name", "summary", "input", "output", "effects", "examples"];

fn contract(
    item: &Value,
    at: &str,
    declared: &[Effect],
    out: &mut Vec<String>,
) -> Option<Contract> {
    let Some(fields) = item.as_object() else {
        out.push(format!("{at} is an object"));
        return None;
    };
    if fields.contains_key("file") && !fields.contains_key("input") {
        out.push(format!(
            "{at}: write the input and output schemas in bot.json; the signed bot.json carries them"
        ));
        return None;
    }
    for key in fields.keys() {
        if !FIELDS.contains(&key.as_str()) && key != "file" {
            out.push(format!("{at}.{key} isn't a field of a contract"));
        }
    }
    let name = fields
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !named(name) {
        out.push(format!(
            "{at}.name is lower-case words joined by _, like cheapest_fare"
        ));
    }
    let summary = fields
        .get("summary")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if summary.is_empty() || summary.chars().count() > SUMMARY_CHARS {
        out.push(format!(
            "{at}.summary says in one line of at most {SUMMARY_CHARS} characters what it answers"
        ));
    }
    let schemas = ["input", "output"].map(|side| {
        let value = fields.get(side).cloned().unwrap_or(Value::Null);
        match schema::read(&value, &format!("{at}.{side}")) {
            Ok(read) => Some((value, read)),
            Err(problems) => {
                out.extend(problems);
                None
            }
        }
    });
    let effects = effects(fields.get("effects"), at, declared, out);
    let [Some((input, input_schema)), Some((output, output_schema))] = schemas else {
        return None;
    };
    let examples = examples(
        fields.get("examples"),
        at,
        &input_schema,
        &output_schema,
        out,
    );
    Some(Contract {
        name: name.to_owned(),
        summary: summary.to_owned(),
        input,
        output,
        effects,
        examples,
    })
}

fn effects(
    value: Option<&Value>,
    at: &str,
    declared: &[Effect],
    out: &mut Vec<String>,
) -> Vec<Effect> {
    let Some(value) = value else {
        return Vec::new();
    };
    let Some(words) = value.as_array() else {
        out.push(format!("{at}.effects lists effect words"));
        return Vec::new();
    };
    let mut effects = Vec::new();
    for word in words {
        let text = word.as_str().unwrap_or_default();
        match Effect::parse(text) {
            // Every call may read and change the bot's own things.
            Some(Effect::Read | Effect::WriteLocal) => {}
            Some(effect) if effect::ceiling::DECLARABLE.contains(&effect) => {
                if declared.contains(&effect) {
                    if !effects.contains(&effect) {
                        effects.push(effect);
                    }
                } else {
                    out.push(format!(
                        "{at}.effects: {text} isn't among the package's effects; a call can use only what the package declares"
                    ));
                }
            }
            _ => out.push(format!(
                "{at}.effects: {text:?} isn't an effect a call may use (network, publish, send_as_person, pay or change_access)"
            )),
        }
    }
    effects
}

fn examples(
    value: Option<&Value>,
    at: &str,
    input: &Schema,
    output: &Schema,
    out: &mut Vec<String>,
) -> Vec<Example> {
    let Some(value) = value else {
        return Vec::new();
    };
    let Some(items) = value
        .as_array()
        .filter(|items| items.len() <= MOST_EXAMPLES)
    else {
        out.push(format!(
            "{at}.examples is a list of at most {MOST_EXAMPLES}"
        ));
        return Vec::new();
    };
    let mut examples = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let here = format!("{at}.examples[{i}]");
        let (Some(given), Some(answer)) = (item.get("input"), item.get("output")) else {
            out.push(format!("{here} has an input and the output it answers"));
            continue;
        };
        for misfit in input
            .check(given, &format!("{here}.input"))
            .into_iter()
            .chain(output.check(answer, &format!("{here}.output")))
        {
            out.push(format!("{misfit}"));
        }
        examples.push(Example {
            input: given.clone(),
            output: answer.clone(),
        });
    }
    examples
}
