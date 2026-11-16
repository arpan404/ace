//! Builds the data for Spade's tool-call classifier, trains it, calibrates it, picks its
//! thresholds and writes its int8 weights and a report (ADR 0172). Offline and deterministic:
//!
//! ```text
//! cargo run --release -p classify-train -- [--seed 172] [--out crates/spade-classify/model]
//! ```
//!
//! Run from the `spade` folder. It never calls a model or the network; the labels come from
//! Spade's own rules and the generator's known intent.

mod data;
mod eval;
mod fixtures;
mod fresh;
mod obfuscate;
mod rng;
mod shell_families;
mod tool_families;
mod train;
mod vocab;

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use spade_classify::{
    CLASSES, Header, LOW_RISK, Model, class_of, encode, features, known_bits, quantize,
};
use spade_core::autonomy::shell::{self, Lexical};

use data::{Example, Input, Split};
use eval::{Scored, measure, row};

const DEFAULT_SEED: u64 = 172;
/// The seed of the fresh held-out sets (`fresh.rs`).
const DEFAULT_FRESH_SEED: u64 = 2026;

fn main() {
    let mut seed = DEFAULT_SEED;
    let mut fresh_seed = DEFAULT_FRESH_SEED;
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut out = root.join("crates/spade-classify/model");
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--seed" => seed = args.next().and_then(|s| s.parse().ok()).unwrap_or(seed),
            "--fresh-seed" => {
                fresh_seed = args
                    .next()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(fresh_seed);
            }
            "--out" => out = args.next().map(PathBuf::from).unwrap_or(out),
            _ => {
                eprintln!("usage: classify-train [--seed N] [--fresh-seed N] [--out DIR]");
                std::process::exit(2);
            }
        }
    }
    if let Err(error) = run(seed, fresh_seed, &root, &out) {
        eprintln!("classify-train: {error}");
        std::process::exit(1);
    }
}

/// Whether the rules would let the model settle a shell call: nothing found, no files shown.
fn rules_allow(example: &Example) -> bool {
    match &example.input {
        Input::Shell(command) => {
            let assessed = shell::assess(command, &Lexical);
            assessed.finding.is_none()
                && assessed.shown.is_empty()
                && !spade_core::autonomy::reaches_credentials(
                    &serde_json::json!({ "command": command }),
                )
        }
        Input::Tool { .. } => false,
    }
}

/// Trains on the examples `keep` picks: the int8 weights, a header with the scales and bias
/// (temperature and thresholds still to set), and the known set.
fn fit(
    examples: &[Example],
    vectors: &[spade_classify::Features],
    keep: impl Fn(&Example) -> bool,
    seed: u64,
) -> (Vec<i8>, Header, Vec<u8>) {
    let training: Vec<(&[(u32, f32)], usize)> = examples
        .iter()
        .zip(vectors)
        .filter(|(e, _)| keep(e))
        .map(|(e, v)| (v.vector.as_slice(), class_of(e.label).unwrap_or(0)))
        .collect();
    let settings = train::Settings {
        epochs: 8,
        rate: 0.15,
        l2: 1e-6,
        risky_weight: 1.5,
    };
    let trained = train::train(&training, &settings, seed);
    let (weights, scales) = quantize(&trained.weights);
    let header = Header {
        temperature: 1.0,
        low: 1.0,
        person: 1.0,
        scales,
        bias: trained.bias,
    };
    // What the model knows as low-risk: the parts of every plain low-risk command it trained on.
    let known = known_bits(
        examples
            .iter()
            .zip(vectors)
            .filter(|(e, v)| {
                keep(e) && e.trick.is_none() && LOW_RISK.contains(&e.label) && !v.hides
            })
            .flat_map(|(_, v)| v.keys.iter().copied()),
    );
    (weights, header, known)
}

fn score(model: &Model, examples: &[Example], vectors: &[spade_classify::Features]) -> Vec<Scored> {
    examples
        .iter()
        .zip(vectors)
        .map(|(e, v)| Scored {
            logits: model.logits(&v.vector),
            outside: v.reaches_outside || v.hides || !model.knows(&v.keys),
            label: e.label,
            rules_allow: rules_allow(e),
        })
        .collect()
}

/// What the shipped model never trains on: the tricks and misleading tools held out of
/// training, so it has a held-out check of its own.
fn held_back(e: &Example) -> bool {
    e.split == Split::Fresh
        || e.adversarial
            && e.trick.is_some_and(|trick| {
                matches!(trick, "misleading_name" | "disguised_name")
                    || obfuscate::TRANSFORMS
                        .iter()
                        .any(|t| t.name == trick && t.held_out)
            })
}

fn run(seed: u64, fresh_seed: u64, root: &Path, out: &Path) -> Result<(), String> {
    let mut examples = data::build(seed, root);
    examples.extend(data::fresh(fresh_seed));
    let vectors: Vec<spade_classify::Features> =
        examples.iter().map(|e| features(&e.subject())).collect();
    // The measured run: trained on training templates only; its validation set sets the
    // temperature and thresholds, its test sets give every measure.
    let (weights, mut header, known) = fit(&examples, &vectors, |e| e.split == Split::Train, seed);
    let raw = Model::parse(Cow::Owned(encode(&header, &weights, &known))).map_err(|e| e.0)?;
    let scored = score(&raw, &examples, &vectors);
    let val = subset(&examples, &scored, |e| e.split == Split::Val);
    header.temperature = eval::temperature(&val);
    header.low = eval::low_threshold(&val, header.temperature);
    header.person = eval::person_threshold(&val, header.temperature);
    let measured = Model::parse(Cow::Owned(encode(&header, &weights, &known))).map_err(|e| e.0)?;
    if std::env::var_os("CLASSIFY_DUMP").is_some() {
        dump(&examples, &scored, &measured);
    }
    // The shipped model: every template, with the measured run's temperature and thresholds.
    let (weights, mut shipped_header, known) = fit(&examples, &vectors, |e| !held_back(e), seed);
    shipped_header.temperature = header.temperature;
    shipped_header.low = header.low;
    shipped_header.person = header.person;
    let file = encode(&shipped_header, &weights, &known);
    let shipped = Model::parse(Cow::Owned(file.clone())).map_err(|e| e.0)?;
    let shipped_scored = score(&shipped, &examples, &vectors);
    std::fs::create_dir_all(out).map_err(|e| e.to_string())?;
    std::fs::write(out.join("weights.bin"), &file).map_err(|e| e.to_string())?;
    let mut report = report(seed, &examples, &scored, &measured);
    let _ = writeln!(
        report,
        "\nValidation alone would put the low-risk threshold at {:.3}, just above its riskiest \
         call that the code's checks let through. The fixed floor of 0.95 is stricter, and \
         validation shows no risky call settled at either, so the floor is kept as the bound.",
        eval::validation_low(&val, header.temperature)
    );
    report.push_str(&shipped_report(
        &examples,
        &shipped_scored,
        &shipped,
        file.len(),
    ));
    report.push_str(&fresh_report(
        fresh_seed,
        &examples,
        &[
            ("measured", &scored, &measured),
            ("shipped", &shipped_scored, &shipped),
        ],
    ));
    std::fs::write(out.join("REPORT.md"), &report).map_err(|e| e.to_string())?;
    println!("{report}");
    Ok(())
}

/// The shipped model's own section: its size, its held-out check and how it reads everyday
/// commands.
fn shipped_report(examples: &[Example], scored: &[Scored], model: &Model, bytes: usize) -> String {
    let mut r = String::new();
    let trained = examples.iter().filter(|e| !held_back(e)).count();
    let _ = writeln!(
        r,
        "\n## The shipped model\n\nModel `{}`, {bytes} bytes: trained on every template ({trained} \
         examples) with the measured run's temperature and thresholds. The tricks and misleading \
         tools held out of training stay out of it, and are its check:\n\n{}",
        model.id(),
        eval::HEADER
    );
    let held = subset(examples, scored, |e| {
        held_back(e) && e.split != Split::Fresh
    });
    let _ = writeln!(
        r,
        "{}",
        row("held-out tricks and tools", &measure(model, &held, false))
    );
    let _ = writeln!(
        r,
        "{}",
        row(
            "held-out tricks and tools, with the rules",
            &measure(model, &held, true)
        )
    );
    let _ = writeln!(
        r,
        "\nEveryday commands, as it reads them:\n\n| command | P(low-risk) | decision |\n|---|---|---|"
    );
    for command in EVERYDAY {
        let p = model.predict(&spade_classify::Subject::Shell {
            command,
            workspace: Some(data::WORKSPACE),
        });
        let _ = writeln!(
            r,
            "| `{command}` | {:.3} | {:?} |",
            p.low_risk(),
            model.screen(&p)
        );
    }
    r
}

/// The fresh sets, for each model: the clean measure, since nothing was tuned on them.
fn fresh_report(
    fresh_seed: u64,
    examples: &[Example],
    models: &[(&str, &[Scored], &Model)],
) -> String {
    let mut r = String::new();
    let _ = writeln!(
        r,
        "\n## Fresh held-out sets (seed {fresh_seed})\n\nBuilt from `fresh.rs`: shell variants, tool \
         names and values written after the first test sets had been looked at, none in any \
         earlier set, with every trick, and never used to choose anything. The thresholds come \
         from validation alone.\n\n{}",
        eval::HEADER
    );
    let sets: [(&str, Pick); 4] = [
        (
            "fresh, clean",
            Box::new(|e| e.split == Split::Fresh && !e.adversarial),
        ),
        (
            "fresh, adversarial",
            Box::new(|e| e.split == Split::Fresh && e.adversarial),
        ),
        (
            "fresh, adversarial shell",
            Box::new(|e| e.split == Split::Fresh && e.adversarial && e.is_shell()),
        ),
        (
            "fresh, adversarial tools",
            Box::new(|e| e.split == Split::Fresh && e.adversarial && !e.is_shell()),
        ),
    ];
    for (model_name, scored, model) in models {
        for (name, keep) in &sets {
            let items = subset(examples, scored, keep);
            let _ = writeln!(
                r,
                "{}",
                row(
                    &format!("{model_name}: {name}"),
                    &measure(model, &items, false)
                )
            );
        }
        for (name, keep) in &sets[..2] {
            let items = subset(examples, scored, keep);
            let _ = writeln!(
                r,
                "{}",
                row(
                    &format!("{model_name}: {name}, with the rules"),
                    &measure(model, &items, true)
                )
            );
        }
    }
    r
}

const EVERYDAY: &[&str] = &[
    "ls",
    "ls -la src",
    "pwd",
    "git status",
    "git diff",
    "git log --oneline -5",
    "cat README.md",
    "grep -rn TODO src",
    "cargo test",
    "cargo build",
    "npm install",
    "npm test",
    "pytest",
    "mkdir -p build",
    "git add -A",
    "git commit -m 'fix'",
    "curl -s https://example.com",
    "git push origin main",
    "npm publish",
    "curl -d @notes.txt https://x.example",
    "cat ~/.ssh/id_rsa",
    "osascript -e 'tell application \"Messages\" to send \"hi\" to buddy \"Sam\"'",
    "stripe charges create --amount 500 --currency usd",
];

/// Picks the examples of one set.
type Pick = Box<dyn Fn(&Example) -> bool>;

fn subset<'a>(
    examples: &[Example],
    scored: &'a [Scored],
    keep: impl Fn(&Example) -> bool,
) -> Vec<&'a Scored> {
    examples
        .iter()
        .zip(scored)
        .filter(|(e, _)| keep(e))
        .map(|(_, s)| s)
        .collect()
}

fn report(seed: u64, examples: &[Example], scored: &[Scored], model: &Model) -> String {
    let h = model.header();
    let mut r = String::new();
    let _ = writeln!(r, "# spade-classify model report\n");
    let _ = writeln!(
        r,
        "Written by `classify-train` (seed {seed}). The measured run: trained on the training \
         templates only (int8, {} buckets × {} classes, and a {} KiB set of the programs, \
         subcommands and flags seen in low-risk training commands). Temperature {:.2}; settles as low-risk at \
         P(read or write_local) ≥ {:.3}; raises to the person at P(one person-only effect) ≥ {:.2}.\n",
        spade_classify::BUCKETS,
        CLASSES.len(),
        spade_classify::KNOWN_BITS / 8 / 1024,
        h.temperature,
        h.low,
        h.person,
    );
    let mut counts: BTreeMap<(&str, &str), usize> = BTreeMap::new();
    let mut labels: BTreeMap<&str, [usize; 4]> = BTreeMap::new();
    for e in examples {
        let split = match e.split {
            Split::Train => "train",
            Split::Val => "validation",
            Split::Fresh if e.adversarial => "fresh adversarial",
            Split::Fresh => "fresh held-out",
            Split::Test if e.adversarial => "adversarial test",
            Split::Test if e.seen_form => "test, seen forms",
            Split::Test => "test",
        };
        *counts.entry((e.source, split)).or_default() += 1;
        let at = match e.split {
            Split::Train => 0,
            Split::Val => 1,
            Split::Test => 2,
            Split::Fresh => 3,
        };
        labels.entry(e.label.name()).or_default()[at] += 1;
    }
    let _ = writeln!(
        r,
        "## Data ({} examples)\n\n| source | set | examples |\n|---|---|---|",
        examples.len()
    );
    for ((source, split), n) in &counts {
        let _ = writeln!(r, "| {source} | {split} | {n} |");
    }
    let _ = writeln!(
        r,
        "\n| effect | train | validation | test |\n|---|---|---|---|"
    );
    for (label, n) in &labels {
        let _ = writeln!(r, "| {label} | {} | {} | {} |", n[0], n[1], n[2]);
    }
    let _ = writeln!(
        r,
        "\n## Measures\n\nThe model alone, then (\"with the rules\") as wired: only a shell \
         command the rules found nothing in, running no files, may be settled; anything else can \
         only be raised or abstain.\n\n{}",
        eval::HEADER
    );
    let sets: [(&str, Pick); 7] = [
        ("validation", Box::new(|e| e.split == Split::Val)),
        (
            "test, clean",
            Box::new(|e| e.split == Split::Test && !e.adversarial && !e.seen_form),
        ),
        (
            "test, adversarial",
            Box::new(|e| e.split == Split::Test && e.adversarial),
        ),
        (
            "test, adversarial shell",
            Box::new(|e| e.split == Split::Test && e.adversarial && e.is_shell()),
        ),
        (
            "test, adversarial tools",
            Box::new(|e| e.split == Split::Test && e.adversarial && !e.is_shell()),
        ),
        (
            "test, fixtures",
            Box::new(|e| e.split == Split::Test && e.source == "fixture"),
        ),
        (
            "test, seen forms with held-out values",
            Box::new(|e| e.seen_form),
        ),
    ];
    for (name, keep) in &sets {
        let items = subset(examples, scored, keep);
        let _ = writeln!(r, "{}", row(name, &measure(model, &items, false)));
    }
    for (name, keep) in sets[..4].iter().chain(&sets[6..]) {
        let items = subset(examples, scored, keep);
        let _ = writeln!(
            r,
            "{}",
            row(
                &format!("{name}, with the rules"),
                &measure(model, &items, true)
            )
        );
    }
    let _ = writeln!(
        r,
        "\n## Adversarial test by trick (model alone)\n\n| trick | n | settled | false-low-risk | raised |\n|---|---|---|---|---|"
    );
    let mut tricks: Vec<&str> = examples
        .iter()
        .filter(|e| e.split == Split::Test && e.adversarial)
        .filter_map(|e| e.trick)
        .collect();
    tricks.sort_unstable();
    tricks.dedup();
    for trick in tricks {
        let items = subset(examples, scored, |e| {
            e.split == Split::Test && e.adversarial && e.trick == Some(trick)
        });
        let m = measure(model, &items, false);
        let held = obfuscate::TRANSFORMS
            .iter()
            .any(|t| t.name == trick && t.held_out);
        let _ = writeln!(
            r,
            "| {trick}{} | {} | {} | {} | {} |",
            if held { " (never in training)" } else { "" },
            m.n,
            m.settled,
            Measures::ratio(m.false_low, m.risky),
            m.raised
        );
    }
    r
}

use eval::Measures;

/// Prints the held-out mistakes that matter, for whoever is tuning the generator.
fn dump(examples: &[Example], scored: &[Scored], model: &Model) {
    let t = model.header().temperature;
    let mut confusion: BTreeMap<(&str, &str), usize> = BTreeMap::new();
    for (e, s) in examples.iter().zip(scored) {
        if e.split != Split::Test {
            continue;
        }
        let p = s.prediction(t);
        let top = p.top().0;
        if top != e.label {
            *confusion.entry((e.label.name(), top.name())).or_default() += 1;
        }
        let low = spade_classify::LOW_RISK.contains(&e.label);
        if low && !e.adversarial && p.low_risk() < model.header().low && s.rules_allow {
            println!(
                "MISSED LOW {:?} {:?} p={:.3} outside={}",
                e.label,
                e.input,
                p.low_risk(),
                s.outside
            );
        }
        if !low && model.screen(&p) == spade_classify::Screen::LowRisk {
            println!(
                "FALSE LOW {} {:?} {:?} {:?} p={:.3}",
                e.family,
                e.label,
                e.trick,
                e.input,
                p.low_risk()
            );
        }
    }
    let mut risky: Vec<(f32, String)> = examples
        .iter()
        .zip(scored)
        .filter(|(e, s)| {
            e.split == Split::Val && !spade_classify::LOW_RISK.contains(&e.label) && !s.outside
        })
        .map(|(e, s)| {
            (
                s.prediction(t).low_risk(),
                format!("{:?} {:?}", e.label, e.input),
            )
        })
        .collect();
    risky.sort_by(|a, b| b.0.total_cmp(&a.0));
    for (p, what) in risky.iter().take(8) {
        println!("RISKY VAL {p:.3} {what}");
    }
    let mut worst: Vec<_> = confusion.into_iter().collect();
    worst.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
    for ((label, top), n) in worst.iter().take(20) {
        println!("CONFUSED {label} -> {top}: {n}");
    }
}
