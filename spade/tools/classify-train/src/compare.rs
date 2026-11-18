//! The linear model against the small MLP (`mlp.rs`), on equal terms: the same training data,
//! the same calibration and threshold rules from validation, the same code checks, measured on
//! the same held-out sets (ADR 0172, amendment 1).

use std::borrow::Cow;
use std::fmt::Write as _;

use spade_classify::{Header, Model, class_of, encode};
use spade_core::effect::Effect;

use crate::data::{Example, Split};
use crate::eval::{self, HEADER, Scored, measure, row};
use crate::mlp;

/// The comparison section of the report. `linear` is the measured linear model and its scores.
pub fn report(
    examples: &[Example],
    vectors: &[spade_classify::Features],
    known: &[u8],
    seed: u64,
    linear: (&Model, &[Scored]),
) -> Result<String, String> {
    let training: Vec<(&[(u32, f32)], usize)> = examples
        .iter()
        .zip(vectors)
        .filter(|(e, _)| e.split == Split::Train)
        .filter_map(|(e, v)| class_of(e.label).map(|c| (v.vector.as_slice(), c)))
        .collect();
    let net = mlp::train(&training, 8, seed);
    let scored: Vec<Scored> = linear
        .1
        .iter()
        .zip(vectors)
        .map(|(s, v)| Scored {
            logits: net.logits(&v.vector),
            outside: s.outside,
            label: s.label,
            rules_allow: s.rules_allow,
            network: s.network,
        })
        .collect();
    let named = pick(examples, &scored, |e| {
        e.split == Split::Val && e.label != Effect::Unknown
    });
    let mut header = *linear.0.header();
    header.temperature = eval::temperature(&named);
    header.low = eval::low_threshold(&named, header.temperature);
    header.person = eval::person_threshold(&named, header.temperature);
    header.read = eval::read_threshold(&named, header.temperature);
    // Only the header and known set of this file are read when measuring from scores.
    let zeros = vec![0i8; spade_classify::BUCKETS * spade_classify::CLASSES.len()];
    let model =
        Model::parse(Cow::Owned(encode(&Header { ..header }, &zeros, known))).map_err(|e| e.0)?;
    let mut r = String::new();
    let _ = writeln!(
        r,
        "\n## The linear model against a small MLP\n\nThe same features, data, class weights, \
         calibration, thresholds and code checks; one hidden layer of {} ReLU units (int8, it \
         would be {} KiB of weights against the linear model's {} KiB, and about {:.1}× the \
         work per call). The MLP's validation picks temperature {:.2}, low-risk threshold \
         {:.3}, person threshold {:.2}.\n\n{HEADER}",
        mlp::HIDDEN,
        spade_classify::BUCKETS * mlp::HIDDEN / 1024,
        spade_classify::BUCKETS * spade_classify::CLASSES.len() / 1024,
        mlp::HIDDEN as f32 / spade_classify::CLASSES.len() as f32,
        header.temperature,
        header.low,
        header.person,
    );
    let sets: [(&str, Keep); 6] = [
        ("validation", |e| {
            e.split == Split::Val && e.source != "tldr"
        }),
        ("test, clean", |e| {
            e.split == Split::Test && !e.adversarial && !e.seen_form && e.source != "tldr"
        }),
        ("test, adversarial", |e| {
            e.split == Split::Test && e.adversarial
        }),
        ("test, tldr-pages held-out pages", |e| {
            e.split == Split::Test && e.source == "tldr"
        }),
        ("fresh, clean", |e| {
            e.split == Split::Fresh && !e.adversarial
        }),
        ("fresh, adversarial", |e| {
            e.split == Split::Fresh && e.adversarial
        }),
    ];
    for (name, keep) in sets {
        let items = pick(examples, linear.1, keep);
        let _ = writeln!(
            r,
            "{}",
            row(
                &format!("linear: {name}"),
                &measure(linear.0, &items, false)
            )
        );
        let items = pick(examples, &scored, keep);
        let _ = writeln!(
            r,
            "{}",
            row(&format!("MLP: {name}"), &measure(&model, &items, false))
        );
    }
    Ok(r)
}

/// Picks the examples of one set.
type Keep = fn(&Example) -> bool;

fn pick<'a>(
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
