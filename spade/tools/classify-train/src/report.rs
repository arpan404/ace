//! The report of the shipped model (ADR 0172, amendments 1 and 2). Every number in it is for the
//! exact weights in `weights.bin`: they are fitted on one part of the data, calibrated (temperature
//! and every threshold) on a part reserved from that fit, and measured on parts neither touched.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use spade_classify::{CLASSES, Model};

use crate::data::{Example, Split};
use crate::eval::{self, HEADER, Measures, Scored, measure, row};
use crate::obfuscate;

/// What an example is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    /// The weights are fitted on it.
    Fit,
    /// Reserved from the fit: the temperature and thresholds are chosen on it.
    Calibration,
    /// Touched by neither: measured only.
    Test,
}

/// The tricks and misleading tools held out of every fit, a check of their own.
pub fn held_out_trick(e: &Example) -> bool {
    e.split != Split::Fresh
        && e.adversarial
        && e.trick.is_some_and(|trick| {
            matches!(trick, "misleading_name" | "disguised_name")
                || obfuscate::TRANSFORMS
                    .iter()
                    .any(|t| t.name == trick && t.held_out)
        })
}

pub fn role(e: &Example) -> Role {
    if e.split == Split::Val {
        Role::Calibration
    } else if e.split == Split::Fresh
        || held_out_trick(e)
        || (e.source == "tldr" && e.split == Split::Test)
    {
        Role::Test
    } else {
        Role::Fit
    }
}

/// Picks the examples of one set.
pub type Keep = fn(&Example) -> bool;

/// The untouched sets, by name.
pub const UNTOUCHED: [(&str, Keep); 6] = [
    ("fresh, clean", |e| {
        e.split == Split::Fresh && !e.adversarial
    }),
    ("fresh, adversarial", |e| {
        e.split == Split::Fresh && e.adversarial
    }),
    ("fresh, adversarial shell", |e| {
        e.split == Split::Fresh && e.adversarial && e.is_shell()
    }),
    ("fresh, adversarial tools", |e| {
        e.split == Split::Fresh && e.adversarial && !e.is_shell()
    }),
    ("held-out tricks and tools", held_out_trick),
    ("tldr-pages, held-out pages", |e| {
        e.source == "tldr" && e.split == Split::Test
    }),
];

pub fn subset<'a>(
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

/// The report's opening sections: the protocol, the data, calibration and the untouched sets.
pub fn head(
    seed: u64,
    fresh_seed: u64,
    examples: &[Example],
    scored: &[Scored],
    model: &Model,
    bytes: usize,
) -> String {
    let h = model.header();
    let mut r = String::new();
    let _ = writeln!(r, "# spade-classify model report\n");
    let _ = writeln!(
        r,
        "Written by `classify-train` (seed {seed}, fresh seed {fresh_seed}). Model `{}`, {bytes} \
         bytes: int8, {} buckets × {} classes, and a {} KiB set of the programs, subcommands and \
         flags seen in low-risk fitted commands. Every number below is for these exact weights. \
         They are fitted on the training data; their temperature and thresholds are chosen on \
         calibration data reserved from that fit (the validation split and tldr-pages' \
         validation pages); and they are measured on data neither touched (the fresh pool, the \
         tricks and misleading tools held out of every fit, tldr-pages' held-out pages, the \
         hand-labelled sets and real sessions).\n",
        model.id(),
        spade_classify::BUCKETS,
        CLASSES.len(),
        spade_classify::KNOWN_BITS / 8 / 1024,
    );
    let _ = writeln!(
        r,
        "Temperature {:.2}. It settles as low-risk at P(read or write_local) ≥ {:.3}, and with \
         untrusted content in view only a read with P(read) ≥ {:.3} as well; it raises to the \
         person at P(any person-only effect) ≥ {:.2}.\n",
        h.temperature, h.low, h.read, h.person,
    );
    let mut counts: BTreeMap<(&str, Role), usize> = BTreeMap::new();
    let mut labels: BTreeMap<&str, [usize; 3]> = BTreeMap::new();
    for e in examples {
        let role = role(e);
        *counts.entry((e.source, role)).or_default() += 1;
        labels.entry(e.label.name()).or_default()[role as usize] += 1;
    }
    let _ = writeln!(
        r,
        "## Data ({} examples)\n\n| source | role | examples |\n|---|---|---|",
        examples.len()
    );
    for ((source, role), n) in &counts {
        let _ = writeln!(r, "| {source} | {role:?} | {n} |");
    }
    let _ = writeln!(
        r,
        "\n| effect | fit | calibration | untouched test |\n|---|---|---|---|"
    );
    for (label, n) in &labels {
        let _ = writeln!(r, "| {label} | {} | {} | {} |", n[0], n[1], n[2]);
    }
    let calibration = subset(examples, scored, |e| role(e) == Role::Calibration);
    let named = subset(examples, scored, |e| {
        role(e) == Role::Calibration && e.label != spade_core::effect::Effect::Unknown
    });
    let _ = writeln!(
        r,
        "\n## Calibration\n\nOn the calibration data alone, the low-risk threshold would be \
         {:.3}: just above its riskiest call with a named risky effect that the code's checks \
         let through. The threshold is that with a margin, never below the floor of {:.2}. The \
         read threshold is above every calibration call that isn't a read and could be settled \
         with untrusted content in view, by 0.02. Calls the labeller can't name count as risky in \
         every measure.\n\n{}",
        eval::validation_low(&named, h.temperature),
        eval::LOW_FLOOR,
        eval::sweep(model, &calibration),
    );
    let _ = writeln!(
        r,
        "\n{HEADER}\n{}\n{}",
        row(
            "calibration, templates",
            &measure(
                model,
                &subset(examples, scored, |e| e.split == Split::Val
                    && e.source != "tldr"),
                false
            )
        ),
        row(
            "calibration, tldr-pages",
            &measure(
                model,
                &subset(examples, scored, |e| e.split == Split::Val
                    && e.source == "tldr"),
                false
            )
        ),
    );
    let _ = writeln!(
        r,
        "\n## Untouched sets\n\nThe model alone, then (\"with the rules\") as wired: only a shell \
         command the rules found nothing in, running no files, may be settled; anything else can \
         only be raised or abstain. The fresh pool (`fresh.rs`, seed {fresh_seed}) was written \
         after the first test sets had been looked at, and nothing is chosen on it.\n\n{HEADER}"
    );
    for (name, keep) in UNTOUCHED {
        let items = subset(examples, scored, keep);
        let _ = writeln!(r, "{}", row(name, &measure(model, &items, false)));
    }
    for (name, keep) in [UNTOUCHED[0], UNTOUCHED[1], UNTOUCHED[4]] {
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
        "\n## Fresh adversarial set by trick (model alone)\n\n| trick | n | settled | false-low-risk | raised |\n|---|---|---|---|---|"
    );
    let mut tricks: Vec<&str> = examples
        .iter()
        .filter(|e| e.split == Split::Fresh && e.adversarial)
        .filter_map(|e| e.trick)
        .collect();
    tricks.sort_unstable();
    tricks.dedup();
    for trick in tricks {
        let items = subset(examples, scored, |e| {
            e.split == Split::Fresh && e.adversarial && e.trick == Some(trick)
        });
        let m = measure(model, &items, false);
        let held = obfuscate::TRANSFORMS
            .iter()
            .any(|t| t.name == trick && t.held_out);
        let _ = writeln!(
            r,
            "| {trick}{} | {} | {} | {} | {} |",
            if held { " (never fitted)" } else { "" },
            m.n,
            m.settled,
            Measures::ratio(m.false_low, m.risky),
            m.raised
        );
    }
    r
}
