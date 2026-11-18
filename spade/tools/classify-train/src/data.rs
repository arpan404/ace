//! The dataset: Spade's own test commands labelled by its rules, and the generator's shell and
//! tool templates labelled by their known intent. Templates (shell variants, tool base names)
//! are split between training, validation and test, and filled from separate halves of each
//! value list, so nothing in a held-out set shares a form or a value with training. Validation
//! holds obfuscated copies made with the training tricks; the adversarial test set holds
//! obfuscated copies of test templates made with every trick, including ones training never
//! saw, and tools whose names hide what their arguments show.

use std::path::Path;

use serde_json::{Map, Value, json};
use spade_classify::{Mcp, Subject};
use spade_core::effect::Effect;

use crate::agent_families::AGENT_FAMILIES;
use crate::fixtures;
use crate::label::{Label, label};
use crate::obfuscate::TRANSFORMS;
use crate::rng::Rng;
use crate::shell_families::{FAMILIES, PREFIXES, SUFFIXES};
use crate::tldr;
use crate::tool_families::{SERVERS, TOOLS, ToolFamily, Val};
use crate::vocab::{Half, expand, value};

/// The bot's folder commands are classified against.
pub const WORKSPACE: &str = "/spade/workspace/bot";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Split {
    Train,
    Val,
    Test,
    /// The fresh held-out pool (`fresh.rs`), from its own seed.
    Fresh,
}

#[derive(Debug, Clone)]
pub enum Input {
    Shell(String),
    Tool {
        name: String,
        arguments: Value,
        hints: Mcp,
    },
}

#[derive(Debug, Clone)]
pub struct Example {
    pub input: Input,
    pub label: Effect,
    pub family: &'static str,
    pub source: &'static str,
    pub split: Split,
    /// The trick that hides it, if any.
    pub trick: Option<&'static str>,
    /// Part of the adversarial set (obfuscated, or a misleading tool).
    pub adversarial: bool,
    /// A training form filled with held-out values: how the model does on the commands it
    /// knows, used for no choice.
    pub seen_form: bool,
}

impl Example {
    pub fn subject(&self) -> Subject<'_> {
        match &self.input {
            Input::Shell(command) => Subject::Shell {
                command,
                workspace: Some(WORKSPACE),
            },
            Input::Tool {
                name,
                arguments,
                hints,
            } => Subject::Tool {
                name,
                arguments,
                hints: *hints,
            },
        }
    }

    pub fn is_shell(&self) -> bool {
        matches!(self.input, Input::Shell(_))
    }
}

/// How many training examples each shell family gets; validation and test get a quarter each.
const SHELL_PER_FAMILY: usize = 360;
const TOOL_PER_FAMILY: usize = 300;

/// Splits `n` templates: about 60% training, 20% validation, 20% test, at least one each when
/// there are three or more. With fewer, all train, and the held-out sets use them with held-out
/// values only.
fn split_counts(n: usize) -> (usize, usize) {
    if n < 3 {
        return (n, 0);
    }
    let val = (n / 5).max(1);
    let test = (n / 5).max(1);
    (n - val - test, val)
}

fn assign<T: Copy>(items: &[T], rng: &mut Rng) -> (Vec<T>, Vec<T>, Vec<T>) {
    let mut order: Vec<T> = items.to_vec();
    rng.shuffle(&mut order);
    let (train, val) = split_counts(order.len());
    let train_part = order[..train].to_vec();
    if val == 0 {
        return (train_part.clone(), train_part.clone(), train_part);
    }
    (
        train_part,
        order[train..train + val].to_vec(),
        order[train + val..].to_vec(),
    )
}

pub fn build(seed: u64, root: &Path) -> Vec<Example> {
    let mut out = Vec::new();
    shell(seed, &mut out);
    tools(seed, &mut out);
    let fixtures = fixture_examples(seed, root);
    out.extend(fixtures);
    out
}

fn compose(command: String, half: Half, rng: &mut Rng) -> String {
    if command.contains('\n') || !rng.chance(0.25) {
        return command;
    }
    if rng.chance(0.5) {
        format!("{}{command}", expand(rng.pick::<&str>(PREFIXES), half, rng))
    } else {
        format!("{command}{}", expand(rng.pick::<&str>(SUFFIXES), half, rng))
    }
}

fn trick(command: &str, held_out_too: bool, rng: &mut Rng) -> Option<(String, &'static str)> {
    for _ in 0..6 {
        let t = rng.pick(TRANSFORMS);
        if t.held_out && !held_out_too {
            continue;
        }
        if let Some(out) = (t.apply)(command, rng) {
            return Some((out, t.name));
        }
    }
    None
}

fn shell(seed: u64, out: &mut Vec<Example>) {
    let mut seen = Vec::new();
    for family in FAMILIES.iter().chain(AGENT_FAMILIES) {
        let mut rng = Rng::stream(seed, family.name);
        let (train, val, test) = assign(family.variants, &mut rng);
        let mut push = |command: String, split, trick: Option<&'static str>, adversarial| {
            out.push(Example {
                input: Input::Shell(command),
                label: family.label,
                family: family.name,
                source: "shell",
                split,
                trick,
                adversarial,
                seen_form: false,
            });
        };
        for i in 0..SHELL_PER_FAMILY / 4 {
            let variant = train[i % train.len()];
            let command = compose(expand(variant, Half::Held, &mut rng), Half::Held, &mut rng);
            seen.push(Example {
                input: Input::Shell(command),
                label: family.label,
                family: family.name,
                source: "shell",
                split: Split::Test,
                trick: None,
                adversarial: false,
                seen_form: true,
            });
        }
        for i in 0..SHELL_PER_FAMILY {
            let variant = train[i % train.len()];
            let command = compose(
                expand(variant, Half::Train, &mut rng),
                Half::Train,
                &mut rng,
            );
            match rng
                .chance(0.3)
                .then(|| trick(&command, false, &mut rng))
                .flatten()
            {
                Some((hidden, name)) => push(hidden, Split::Train, Some(name), false),
                None => push(command, Split::Train, None, false),
            }
        }
        for i in 0..SHELL_PER_FAMILY / 4 {
            let variant = val[i % val.len()];
            let command = compose(expand(variant, Half::Held, &mut rng), Half::Held, &mut rng);
            if let Some((hidden, name)) = trick(&command, false, &mut rng) {
                push(hidden, Split::Val, Some(name), true);
            }
            push(command, Split::Val, None, false);
        }
        for i in 0..SHELL_PER_FAMILY / 4 {
            let variant = test[i % test.len()];
            let command = compose(expand(variant, Half::Held, &mut rng), Half::Held, &mut rng);
            for _ in 0..3 {
                if let Some((hidden, name)) = trick(&command, true, &mut rng) {
                    push(hidden, Split::Test, Some(name), true);
                }
            }
            push(command, Split::Test, None, false);
        }
    }
    out.extend(seen);
}

/// A snake-case base name in one of the styles servers use.
fn styled(base: &str, held: bool, rng: &mut Rng) -> String {
    let words: Vec<&str> = base.split('_').collect();
    let camel = |upper_first: bool| -> String {
        words
            .iter()
            .enumerate()
            .map(|(i, w)| {
                let mut chars = w.chars();
                match chars.next() {
                    Some(first) if i > 0 || upper_first => {
                        first.to_uppercase().chain(chars).collect::<String>()
                    }
                    _ => (*w).to_owned(),
                }
            })
            .collect()
    };
    let server = rng.pick(SERVERS);
    let styles = if held { 8 } else { 5 };
    match rng.below(styles) {
        0 => base.to_owned(),
        1 => camel(false),
        2 => format!("{server}__{base}"),
        3 => words.join("-"),
        4 => format!("{server}_{base}"),
        5 => format!("{server}.{}", camel(false)),
        6 => format!("mcp__{server}__{base}"),
        _ => base.to_ascii_uppercase(),
    }
}

fn id(half: Half, rng: &mut Rng) -> String {
    let prefix = rng.pick(&["id", "cus", "ch", "pi", "msg", "usr", "doc", "C0", "T1"]);
    format!(
        "{prefix}_{}{}",
        value("num", half, rng),
        value("word", half, rng)
    )
}

fn fill(val: Val, half: Half, rng: &mut Rng) -> Value {
    match val {
        Val::Text => json!(value(
            if rng.chance(0.5) { "word" } else { "msg" },
            half,
            rng
        )),
        Val::Message => json!(value("msg", half, rng)),
        Val::Email => json!(value("to", half, rng)),
        Val::Phone => json!(value("phone", half, rng)),
        Val::Url => json!(value("url", half, rng)),
        Val::Id => json!(id(half, rng)),
        Val::Number => json!(value("num", half, rng).parse::<u64>().unwrap_or(1)),
        Val::Amount => {
            let amount = value("amount", half, rng);
            if rng.chance(0.7) {
                json!(amount.parse::<u64>().unwrap_or(100))
            } else {
                json!(format!("${amount}.00"))
            }
        }
        Val::Currency => json!(rng.pick(&["usd", "eur", "gbp", "USD", "jpy"])),
        Val::Bool(b) => json!(b),
        Val::Role => json!(rng.pick(&["admin", "editor", "owner", "viewer", "write", "maintain"])),
        Val::Path => json!(value("file", half, rng)),
        Val::Labels => json!([value("word", half, rng), value("word", half, rng)]),
        Val::Fields => json!({ "status": value("word", half, rng), "priority": 2 }),
        Val::Env => json!(value("env_name", half, rng)),
        Val::Version => json!(format!("v1.{}.0", value("num", half, rng))),
        Val::Selector => json!(rng.pick(&[
            "#submit",
            "button.buy-now",
            "input[name=q]",
            "a.next",
            "#checkout"
        ])),
        Val::Key => json!(rng.pick(&["Enter", "Tab", "cmd+v", "Escape", "ctrl+c"])),
        Val::Command(effect) => {
            let families: Vec<_> = FAMILIES.iter().filter(|f| f.label == effect).collect();
            let family = rng.pick(&families);
            json!(expand(rng.pick::<&str>(family.variants), half, rng))
        }
    }
}

fn call(family: &ToolFamily, base: &str, half: Half, held_style: bool, rng: &mut Rng) -> Input {
    let name = styled(base, held_style, rng);
    let mut arguments = Map::new();
    for (key, val) in *rng.pick(family.arguments) {
        arguments.insert((*key).to_owned(), fill(*val, half, rng));
    }
    let read_only = rng.chance(family.read_only);
    let declared = match rng.below(10) {
        0..=5 => None,
        6..=8 if !read_only => Some(Effect::Network),
        _ if family.label == Effect::Publish => Some(Effect::Publish),
        _ => None,
    };
    Input::Tool {
        name,
        arguments: Value::Object(arguments),
        hints: Mcp {
            read_only,
            annotated: rng.chance(0.8),
            declared,
        },
    }
}

/// A tool name with one letter swapped for a look-alike, or a zero-width space inside.
fn disguised(input: Input, rng: &mut Rng) -> Input {
    let Input::Tool {
        name,
        arguments,
        hints,
    } = input
    else {
        return input;
    };
    let name = if rng.chance(0.5) {
        name.replacen('e', "е", 1).replacen('a', "а", 1)
    } else {
        let at = name.len() / 2;
        let at = (0..=at)
            .rev()
            .find(|i| name.is_char_boundary(*i))
            .unwrap_or(0);
        format!("{}\u{200b}{}", &name[..at], &name[at..])
    };
    Input::Tool {
        name,
        arguments,
        hints,
    }
}

fn tools(seed: u64, out: &mut Vec<Example>) {
    for family in TOOLS {
        let mut rng = Rng::stream(seed, family.name);
        let mut push = |input, split, trick, adversarial| {
            out.push(Example {
                input,
                label: family.label,
                family: family.name,
                source: "tool",
                split,
                trick,
                adversarial,
                seen_form: false,
            });
        };
        if family.adversarial {
            for _ in 0..TOOL_PER_FAMILY / 2 {
                let base = *rng.pick(family.bases);
                let input = call(family, base, Half::Held, true, &mut rng);
                push(input, Split::Test, Some("misleading_name"), true);
            }
            continue;
        }
        let (train, val, test) = assign(family.bases, &mut rng);
        for i in 0..TOOL_PER_FAMILY {
            let input = call(family, train[i % train.len()], Half::Train, false, &mut rng);
            push(input, Split::Train, None, false);
        }
        for i in 0..TOOL_PER_FAMILY / 4 {
            let input = call(family, val[i % val.len()], Half::Held, false, &mut rng);
            push(input, Split::Val, None, false);
        }
        for i in 0..TOOL_PER_FAMILY / 4 {
            let input = call(family, test[i % test.len()], Half::Held, true, &mut rng);
            push(input.clone(), Split::Test, None, false);
            push(
                disguised(input, &mut rng),
                Split::Test,
                Some("disguised_name"),
                true,
            );
        }
    }
}

/// How many clean examples each fresh family gets; shell ones get three obfuscated copies each.
const FRESH_PER_FAMILY: usize = 60;

/// The fresh held-out and adversarial sets, from `fresh_seed`: fresh variants, tool names and
/// values only, with every trick (none composed with the earlier prefixes or suffixes).
pub fn fresh(fresh_seed: u64) -> Vec<Example> {
    let mut out = Vec::new();
    for family in crate::fresh::SHELL {
        let mut rng = Rng::stream(fresh_seed, family.name);
        for i in 0..FRESH_PER_FAMILY {
            let variant = family.variants[i % family.variants.len()];
            let command = expand(variant, Half::Fresh, &mut rng);
            for _ in 0..3 {
                if let Some((hidden, name)) = trick(&command, true, &mut rng) {
                    out.push(Example {
                        input: Input::Shell(hidden),
                        label: family.label,
                        family: family.name,
                        source: "shell",
                        split: Split::Fresh,
                        trick: Some(name),
                        adversarial: true,
                        seen_form: false,
                    });
                }
            }
            out.push(Example {
                input: Input::Shell(command),
                label: family.label,
                family: family.name,
                source: "shell",
                split: Split::Fresh,
                trick: None,
                adversarial: false,
                seen_form: false,
            });
        }
    }
    for family in crate::fresh::TOOLS {
        let mut rng = Rng::stream(fresh_seed, &format!("tool-{}", family.name));
        for i in 0..FRESH_PER_FAMILY {
            let base = family.bases[i % family.bases.len()];
            let input = call(family, base, Half::Fresh, true, &mut rng);
            let example = |input, trick, adversarial| Example {
                input,
                label: family.label,
                family: family.name,
                source: "tool",
                split: Split::Fresh,
                trick,
                adversarial,
                seen_form: false,
            };
            if family.adversarial {
                out.push(example(input, Some("misleading_name"), true));
            } else {
                out.push(example(input.clone(), None, false));
                out.push(example(
                    disguised(input, &mut rng),
                    Some("disguised_name"),
                    true,
                ));
            }
        }
    }
    out
}

fn fixture_examples(seed: u64, root: &Path) -> Vec<Example> {
    let mut programs: Vec<String> = FAMILIES
        .iter()
        .flat_map(|f| f.variants.iter())
        .filter_map(|v| v.split_whitespace().next())
        .map(|w| w.rsplit('/').next().unwrap_or(w).to_owned())
        .collect();
    programs.extend(
        [
            "ssh",
            "scp",
            "npm",
            "pnpm",
            "yarn",
            "make",
            "just",
            "find",
            "xargs",
            "sudo",
            "env",
            "timeout",
            "nohup",
            "kubectl",
            "helm",
            "terraform",
            "docker",
            "gh",
            "git",
            "osascript",
            "open",
            "stripe",
            "paypal",
            "mail",
            "sendmail",
            "python",
            "python3",
            "node",
            "perl",
            "ruby",
            "sh",
            "bash",
            "zsh",
            "cat",
            "cp",
            "mv",
            "rm",
            "tee",
            "dd",
            "ln",
            "echo",
            "curl",
            "wget",
            "nc",
            "http",
            "xh",
            "shortcuts",
            "launchctl",
            "crontab",
        ]
        .map(str::to_owned),
    );
    programs.sort();
    programs.dedup();
    let mut rng = Rng::stream(seed, "fixtures");
    fixtures::commands(root, &programs)
        .into_iter()
        .map(|(command, label)| {
            let split = match rng.below(10) {
                0 => Split::Val,
                1 => Split::Test,
                _ => Split::Train,
            };
            Example {
                input: Input::Shell(command),
                label,
                family: "fixture",
                source: "fixture",
                split,
                trick: None,
                adversarial: false,
                seen_form: false,
            }
        })
        .collect()
}

/// tldr-pages examples, labelled by the reference labeller (`label.rs`) and split by page: one in
/// five pages is test and one validation, so a held-out page shares no form with training. One
/// the labeller can't name is `unknown`: measured as risky, never trained on.
pub fn tldr(examples: &[tldr::Example]) -> Vec<Example> {
    examples
        .iter()
        .map(|e| Example {
            input: Input::Shell(e.command.clone()),
            label: match label(&e.command, Some(&e.description)) {
                Label::Sure(effect) => effect,
                Label::Unsure => Effect::Unknown,
            },
            family: "tldr",
            source: "tldr",
            split: if crate::measure::tldr_test_page(&e.page) {
                Split::Test
            } else if crate::measure::tldr_val_page(&e.page) {
                Split::Val
            } else {
                Split::Train
            },
            trick: None,
            adversarial: false,
            seen_form: false,
        })
        .collect()
}
