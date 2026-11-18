//! Builds the data for Spade's tool-call classifier, trains it, calibrates it, picks its
//! thresholds and writes its int8 weights and a report (ADR 0172). Offline and deterministic:
//!
//! ```text
//! cargo run --release -p classify-train -- [--seed 172] [--out crates/spade-classify/model]
//! ```
//!
//! Run from the `spade` folder. It never calls a model or the network; the labels come from
//! Spade's own rules and the generator's known intent.

mod agent_families;
mod compare;
mod connectors;
mod data;
mod eval;
mod fixtures;
mod fresh;
mod hard;
mod label;
mod measure;
mod mlp;
mod obfuscate;
mod overlap;
mod real;
mod replay;
mod report;
mod rng;
mod shell_families;
mod tldr;
mod tool_families;
mod train;
mod vocab;

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use spade_classify::{Header, LOW_RISK, Model, class_of, encode, features, known_bits, quantize};
use spade_core::autonomy::shell::{self, Lexical};

use data::{Example, Input, Split};
use eval::Scored;

const DEFAULT_SEED: u64 = 172;
/// The seed of the fresh held-out sets (`fresh.rs`).
const DEFAULT_FRESH_SEED: u64 = 2026;

fn main() {
    if std::env::args().nth(1).as_deref() == Some("measure") {
        if let Err(error) = measure_only(std::env::args().skip(2)) {
            eprintln!("classify-train: {error}");
            std::process::exit(1);
        }
        return;
    }
    let mut seed = DEFAULT_SEED;
    let mut fresh_seed = DEFAULT_FRESH_SEED;
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut out = root.join("crates/spade-classify/model");
    let (mut tldr_dir, mut real_dir) = (None, None);
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
            "--tldr" => tldr_dir = args.next().map(PathBuf::from),
            "--real" => real_dir = args.next().map(PathBuf::from),
            _ => {
                eprintln!(
                    "usage: classify-train [--seed N] [--fresh-seed N] [--out DIR] [--tldr DIR] [--real DIR]\n       classify-train measure [--weights FILE] [--tldr DIR] [--real DIR]"
                );
                std::process::exit(2);
            }
        }
    }
    let Some(tldr_dir) = tldr_dir else {
        eprintln!(
            "classify-train: the shipped model trains on tldr-pages; fetch it with \
             tools/classify-train/fetch-corpora.sh DIR and pass --tldr DIR/tldr"
        );
        std::process::exit(2);
    };
    let corpora = Corpora {
        tldr: &tldr_dir,
        real: real_dir.as_deref(),
    };
    if let Err(error) = run(seed, fresh_seed, &root, &out, corpora) {
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
        // A call the labeller can't name is measured, never trained on.
        .filter_map(|(e, v)| class_of(e.label).map(|c| (v.vector.as_slice(), c)))
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
        read: 1.0,
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
            outside: v.reaches_outside
                || v.hides
                || v.dropped
                || !v.hardened
                || !model.knows(&v.keys),
            label: e.label,
            rules_allow: rules_allow(e),
            network: v.network,
        })
        .collect()
}

/// The public corpus the model trains on, and the real sessions it is only measured on.
#[derive(Clone, Copy)]
struct Corpora<'a> {
    tldr: &'a Path,
    real: Option<&'a Path>,
}

fn run(
    seed: u64,
    fresh_seed: u64,
    root: &Path,
    out: &Path,
    corpora: Corpora<'_>,
) -> Result<(), String> {
    let tldr_examples = tldr::read(corpora.tldr)?;
    let real_calls = corpora.real.map(real::read).transpose()?;
    let mut examples = data::build(seed, root);
    examples.extend(data::fresh(fresh_seed));
    examples.extend(data::tldr(&tldr_examples));
    let vectors: Vec<spade_classify::Features> =
        examples.iter().map(|e| features(&e.subject())).collect();
    // Hold the calibration and test sets apart from the fit set by folded signature, so no call
    // the model can't tell from a fit call is used to tune or measure it (ADR 0172, amendment 6):
    // disguised tool clones and commands like `pwd` that recur verbatim are dropped.
    let fit_signatures: std::collections::HashSet<u64> = examples
        .iter()
        .zip(&vectors)
        .filter(|(e, _)| report::role(e) == report::Role::Fit)
        .map(|(_, v)| overlap::signature(v))
        .collect();
    let mut overlap_removed = 0usize;
    let (mut kept_examples, mut kept_vectors) = (Vec::new(), Vec::new());
    for (e, v) in examples.into_iter().zip(vectors) {
        if report::role(&e) != report::Role::Fit && fit_signatures.contains(&overlap::signature(&v))
        {
            overlap_removed += 1;
            continue;
        }
        kept_examples.push(e);
        kept_vectors.push(v);
    }
    let (examples, vectors) = (kept_examples, kept_vectors);
    // The corpus-wide check: after holding out, no calibration or test call shares a fit call's
    // folded signature. A regression here fails the build.
    assert!(
        examples
            .iter()
            .zip(&vectors)
            .all(|(e, v)| report::role(e) == report::Role::Fit
                || !fit_signatures.contains(&overlap::signature(v))),
        "a calibration or test call still shares a fit call's folded signature",
    );
    let fit_set = overlap::Fit::new(fit_signatures);
    // One model: fitted on the fit data, calibrated on data reserved from the fit, measured on
    // data neither touched. The file written is these exact weights.
    let fitted = |e: &Example| report::role(e) == report::Role::Fit;
    let (weights, mut header, known) = fit(&examples, &vectors, fitted, seed);
    let raw = Model::parse(Cow::Owned(encode(&header, &weights, &known))).map_err(|e| e.0)?;
    let scored = score(&raw, &examples, &vectors);
    // The temperature and the person threshold are fitted to the calibration calls whose effect
    // the labels name. The low-risk and read thresholds are chosen on every calibration call,
    // one the labeller can't name counted as unsafe, with the checks the gate applies at run
    // time (outside the folder, hidden, unknown parts, no hard form) applied.
    let named = report::subset(&examples, &scored, |e| {
        report::role(e) == report::Role::Calibration
            && e.label != spade_core::effect::Effect::Unknown
    });
    let calibration = report::subset(&examples, &scored, |e| {
        report::role(e) == report::Role::Calibration
    });
    header.temperature = eval::temperature(&named);
    header.low = eval::low_threshold(&calibration, header.temperature);
    header.person = eval::person_threshold(&named, header.temperature);
    header.read = eval::read_threshold(&calibration, header.temperature);
    let file = encode(&header, &weights, &known);
    let shipped = Model::parse(Cow::Owned(file.clone())).map_err(|e| e.0)?;
    if std::env::var_os("CLASSIFY_DUMP").is_some() {
        dump(&examples, &scored, &shipped);
    }
    std::fs::create_dir_all(out).map_err(|e| e.to_string())?;
    std::fs::write(out.join("weights.bin"), &file).map_err(|e| e.to_string())?;
    let mut report = report::head(seed, fresh_seed, &examples, &scored, &shipped, file.len());
    let _ = writeln!(
        report,
        "\n{overlap_removed} calibration or test calls were held out of the fit set by folded \
         signature (ADR 0172, amendment 6).",
    );
    report.push_str(&everyday(&shipped));
    // Only this build's wiring: a faithful `main` baseline needs main's model and logic and is
    // produced separately (ADR 0172, amendment 6), not by passing the shipped model here.
    let wirings: [(&str, replay::Decide<'_>, bool); 1] = [("this build", &decide_this, true)];
    report.push_str(&measure::report(
        &shipped,
        Some(&tldr_examples),
        real_calls.as_deref(),
        &fit_set,
        &wirings,
    ));
    if std::env::var_os("CLASSIFY_SKIP_MLP").is_none() {
        report.push_str(&compare::report(
            &examples,
            &vectors,
            &known,
            seed,
            (&shipped, &scored),
        )?);
    }
    std::fs::write(out.join("REPORT.md"), &report).map_err(|e| e.to_string())?;
    println!("{report}");
    Ok(())
}

/// How the shipped model reads everyday commands.
fn everyday(model: &Model) -> String {
    let mut r = String::from(
        "\n## Everyday commands, as it reads them\n\n| command | P(low-risk) | P(read) | decision |\n|---|---|---|---|\n",
    );
    for command in EVERYDAY {
        let p = model.predict(&spade_classify::Subject::Shell {
            command,
            workspace: Some(data::WORKSPACE),
        });
        let _ = writeln!(
            r,
            "| `{command}` | {:.3} | {:.3} | {:?} |",
            p.low_risk(),
            p.of(spade_core::effect::Effect::Read),
            model.screen(&p)
        );
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
            report::role(e) == report::Role::Calibration
                && !spade_classify::LOW_RISK.contains(&e.label)
                && !s.outside
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
    let mut writes: Vec<(f32, String)> = examples
        .iter()
        .zip(scored)
        .filter(|(e, s)| {
            report::role(e) == report::Role::Calibration
                && e.label != spade_core::effect::Effect::Read
                && !s.outside
                && !s.network
        })
        .map(|(e, s)| {
            (
                s.prediction(t).of(spade_core::effect::Effect::Read),
                format!("{} {:?} {:?}", e.family, e.label, e.input),
            )
        })
        .collect();
    writes.sort_by(|a, b| b.0.total_cmp(&a.0));
    for (p, what) in writes.iter().take(40) {
        println!("NOT-READ VAL {p:.3} {what}");
    }
    let mut worst: Vec<_> = confusion.into_iter().collect();
    worst.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
    for ((label, top), n) in worst.iter().take(20) {
        println!("CONFUSED {label} -> {top}: {n}");
    }
}

/// The classifier's decision as this build wires it (`spade_classify::Model::decide`).
fn decide_this(
    model: &Model,
    subject: &spade_classify::Subject<'_>,
    reviewing: spade_classify::Reviewing,
    config_clean: spade_classify::ConfigTools,
) -> spade_classify::Screen {
    model.decide(subject, reviewing, config_clean).screen
}

/// `classify-train measure [--weights FILE] [--tldr DIR] [--real DIR]`: the realistic measures
/// of a model file (the built-in one by default), printed; real sessions only as aggregates.
fn measure_only(mut args: impl Iterator<Item = String>) -> Result<(), String> {
    let (mut weights, mut tldr_dir, mut real_dir) = (None, None, None);
    while let Some(arg) = args.next() {
        let value = args.next().map(PathBuf::from);
        match arg.as_str() {
            "--weights" => weights = value,
            "--tldr" => tldr_dir = value,
            "--real" => real_dir = value,
            _ => {
                return Err(
                    "usage: classify-train measure [--weights FILE] [--tldr DIR] [--real DIR]"
                        .into(),
                );
            }
        }
    }
    let model = match weights {
        Some(path) => {
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            Model::parse(Cow::Owned(bytes)).map_err(|e| e.0)?
        }
        None => Model::parse(Cow::Borrowed(include_bytes!(
            "../../../crates/spade-classify/model/weights.bin"
        )))
        .map_err(|e| e.0)?,
    };
    let tldr = tldr_dir.map(|d| tldr::read(&d)).transpose()?;
    let real = real_dir.map(|d| real::read(&d)).transpose()?;
    let wirings: [(&str, replay::Decide<'_>, bool); 1] = [("this build", &decide_this, true)];
    println!(
        "Model `{}`.\n{}",
        model.id(),
        measure::report(
            &model,
            tldr.as_deref(),
            real.as_deref(),
            &overlap::Fit::new(std::iter::empty()),
            &wirings
        )
    );
    Ok(())
}
