//! Softmax regression over the sparse features, trained with AdaGrad in a fixed order from a
//! seeded shuffle: the same data and seed give the same weights, bit for bit, on one machine.

use spade_classify::{BUCKETS, CLASSES, LOW_RISK};

use crate::rng::Rng;

const C: usize = CLASSES.len();

pub struct Trained {
    /// `BUCKETS × classes`, row-major.
    pub weights: Vec<f32>,
    pub bias: [f32; C],
}

pub struct Settings {
    pub epochs: usize,
    pub rate: f32,
    pub l2: f32,
    /// How much more a mistake on a call that isn't low-risk costs: calling a risky call
    /// low-risk is the error that matters.
    pub risky_weight: f32,
}

fn softmax(logits: &mut [f32; C]) {
    let top = logits.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let mut total = 0.0;
    for l in logits.iter_mut() {
        *l = (*l - top).exp();
        total += *l;
    }
    for l in logits.iter_mut() {
        *l /= total;
    }
}

pub fn train(data: &[(&[(u32, f32)], usize)], settings: &Settings, seed: u64) -> Trained {
    let mut weights = vec![0.0f32; BUCKETS * C];
    let mut squares = vec![1e-6f32; BUCKETS * C];
    let mut bias = [0.0f32; C];
    let mut bias_squares = [1e-6f32; C];
    // Classes balanced by how often they occur, risky ones weighted up.
    let mut counts = [0usize; C];
    for (_, label) in data {
        counts[*label] += 1;
    }
    let total = data.len().max(1) as f32;
    let mut class_weight = [0.0f32; C];
    for c in 0..C {
        let balanced = if counts[c] == 0 {
            0.0
        } else {
            total / (C as f32 * counts[c] as f32)
        };
        let risky = !LOW_RISK.contains(&CLASSES[c]);
        class_weight[c] = balanced.sqrt() * if risky { settings.risky_weight } else { 1.0 };
    }
    let mut order: Vec<usize> = (0..data.len()).collect();
    let mut rng = Rng::stream(seed, "train");
    for _ in 0..settings.epochs {
        rng.shuffle(&mut order);
        for &i in &order {
            let (features, label) = data[i];
            let mut p = bias;
            for &(row, x) in features {
                let at = row as usize * C;
                for c in 0..C {
                    p[c] += weights[at + c] * x;
                }
            }
            softmax(&mut p);
            let scale = class_weight[label];
            let mut grad = [0.0f32; C];
            for c in 0..C {
                grad[c] = (p[c] - if c == label { 1.0 } else { 0.0 }) * scale;
            }
            for &(row, x) in features {
                let at = row as usize * C;
                for c in 0..C {
                    let g = grad[c] * x + settings.l2 * weights[at + c];
                    squares[at + c] += g * g;
                    weights[at + c] -= settings.rate * g / squares[at + c].sqrt();
                }
            }
            for c in 0..C {
                bias_squares[c] += grad[c] * grad[c];
                bias[c] -= settings.rate * grad[c] / bias_squares[c].sqrt();
            }
        }
    }
    Trained { weights, bias }
}
