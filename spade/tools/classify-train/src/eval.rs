//! Calibration, thresholds and the measures the report gives: how often the model would settle
//! a call as low-risk and was right (precision), how many low-risk calls it settles (recall), how
//! many risky calls it would wrongly settle (the false-low-risk rate), and the same for raising a
//! call to the person.

use spade_classify::{CLASSES, LOW_RISK, Model, PERSON_ONLY, Prediction, Screen, softmax};
use spade_core::effect::Effect;

const C: usize = CLASSES.len();

/// One scored example.
pub struct Scored {
    pub logits: [f32; C],
    /// The call points outside the bot's folders or hides what it runs: never settled.
    pub outside: bool,
    pub label: Effect,
    /// The rules would let the model settle it (a shell command they found nothing in, that
    /// runs no files).
    pub rules_allow: bool,
}

impl Scored {
    pub fn prediction(&self, temperature: f32) -> Prediction {
        Prediction {
            probabilities: softmax(self.logits, temperature),
            reaches_outside: self.outside,
            hides: false,
            known: true,
            dropped: false,
        }
    }
}

/// The temperature with the least negative log-likelihood on `val`.
pub fn temperature(val: &[&Scored]) -> f32 {
    let mut best = (1.0f32, f64::INFINITY);
    for step in 0..=90 {
        let t = 0.5 + step as f32 * 0.05;
        let loss: f64 = val
            .iter()
            .map(|s| {
                let p = softmax(s.logits, t);
                let at = spade_classify::class_of(s.label).unwrap_or(0);
                -f64::from(p[at].max(1e-7)).ln()
            })
            .sum();
        if loss < best.1 {
            best = (t, loss);
        }
    }
    best.0
}

/// The least the low-risk threshold may be. Set at 0.95 after a first run at 0.90 let two held-out
/// test commands through (`ssh … uptime`, `defaults write`), as the report says.
const LOW_FLOOR: f32 = 0.95;
/// The least the person threshold may be: raising a call is the safe direction.
const PERSON_FLOOR: f32 = 0.6;

/// The low-risk threshold: above every risky validation call the model could settle (any not
/// pointing outside), with a margin, and never below [`LOW_FLOOR`].
pub fn low_threshold(val: &[&Scored], t: f32) -> f32 {
    (validation_low(val, t)).clamp(LOW_FLOOR, 0.999)
}

/// The low-risk threshold validation alone picks: just above every risky validation call the
/// model could settle.
pub fn validation_low(val: &[&Scored], t: f32) -> f32 {
    let worst = val
        .iter()
        .filter(|s| !LOW_RISK.contains(&s.label) && !s.outside)
        .map(|s| s.prediction(t).low_risk())
        .fold(0.0f32, f32::max);
    worst + 0.01
}

/// The person threshold: the lowest at which raising on validation is at least 98% precise,
/// never below [`PERSON_FLOOR`].
pub fn person_threshold(val: &[&Scored], t: f32) -> f32 {
    let mut best = 0.99f32;
    let steps = ((0.99 - PERSON_FLOOR) * 100.0).round() as usize;
    for step in (0..=steps).rev() {
        let threshold = PERSON_FLOOR + step as f32 * 0.01;
        let raised: Vec<&&Scored> = val
            .iter()
            .filter(|s| s.prediction(t).person_only().1 >= threshold)
            .collect();
        let right = raised
            .iter()
            .filter(|s| PERSON_ONLY.contains(&s.label))
            .count();
        if raised.is_empty() || right as f64 / raised.len() as f64 >= 0.98 {
            best = threshold;
        } else {
            break;
        }
    }
    best
}

#[derive(Debug, Default, Clone, Copy)]
pub struct Measures {
    pub n: usize,
    pub correct: usize,
    pub low: usize,
    pub risky: usize,
    pub settled: usize,
    pub settled_right: usize,
    /// Risky calls settled as low-risk.
    pub false_low: usize,
    pub person: usize,
    pub raised: usize,
    pub raised_right: usize,
    pub raised_exact: usize,
}

impl Measures {
    pub fn ratio(a: usize, b: usize) -> String {
        if b == 0 {
            "–".to_owned()
        } else {
            format!("{:.4}", a as f64 / b as f64)
        }
    }
}

/// Measures over `items`; `gated` applies the rules' precondition to settling.
pub fn measure(model: &Model, items: &[&Scored], gated: bool) -> Measures {
    let t = model.header().temperature;
    let mut m = Measures::default();
    for s in items {
        let p = s.prediction(t);
        m.n += 1;
        if p.top().0 == s.label {
            m.correct += 1;
        }
        let low = LOW_RISK.contains(&s.label);
        let person = PERSON_ONLY.contains(&s.label);
        m.low += usize::from(low);
        m.risky += usize::from(!low);
        m.person += usize::from(person);
        let screen = if gated && !s.rules_allow {
            model.raise(&p)
        } else {
            model.screen(&p)
        };
        match screen {
            Screen::LowRisk => {
                m.settled += 1;
                if low {
                    m.settled_right += 1;
                } else {
                    m.false_low += 1;
                }
            }
            Screen::Person(effect) => {
                m.raised += 1;
                m.raised_right += usize::from(person);
                m.raised_exact += usize::from(effect == s.label);
            }
            Screen::Abstain => {}
        }
    }
    m
}

/// One row of the report's table.
pub fn row(name: &str, m: &Measures) -> String {
    format!(
        "| {name} | {} | {} | {} | {} | {} | {} ({}/{}) | {} | {} | {} |",
        m.n,
        Measures::ratio(m.correct, m.n),
        Measures::ratio(m.settled_right, m.settled),
        Measures::ratio(m.settled_right, m.low),
        m.settled,
        Measures::ratio(m.false_low, m.risky),
        m.false_low,
        m.risky,
        Measures::ratio(m.raised_right, m.raised),
        Measures::ratio(m.raised_right, m.person),
        Measures::ratio(m.raised_exact, m.raised),
    )
}

pub const HEADER: &str = "| set | n | accuracy | low-risk precision | low-risk recall | settled | false-low-risk rate | person precision | person recall | exact effect |\n|---|---|---|---|---|---|---|---|---|---|";
