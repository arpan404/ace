//! The experiment behind ADR 0172 amendment 1's choice of model: a small multilayer perceptron
//! (one hidden ReLU layer) over the same hashed features, trained on the same data with the same
//! class weights and AdaGrad, seeded the same way. Its scores go through the same calibration,
//! thresholds and code checks as the linear model's, so the two compare on equal terms. It is
//! measured, never shipped.

use spade_classify::{BUCKETS, CLASSES, LOW_RISK};

use crate::rng::Rng;

const C: usize = CLASSES.len();
/// Hidden units.
pub const HIDDEN: usize = 16;

pub struct Mlp {
    w1: Vec<f32>,
    b1: [f32; HIDDEN],
    w2: [[f32; C]; HIDDEN],
    b2: [f32; C],
}

impl Mlp {
    fn hidden(&self, features: &[(u32, f32)]) -> [f32; HIDDEN] {
        let mut h = self.b1;
        for &(row, x) in features {
            let at = row as usize * HIDDEN;
            for (j, hj) in h.iter_mut().enumerate() {
                *hj += self.w1[at + j] * x;
            }
        }
        h.map(|v| v.max(0.0))
    }

    pub fn logits(&self, features: &[(u32, f32)]) -> [f32; C] {
        let h = self.hidden(features);
        let mut out = self.b2;
        for (j, hj) in h.iter().enumerate() {
            for (c, o) in out.iter_mut().enumerate() {
                *o += self.w2[j][c] * hj;
            }
        }
        out
    }
}

fn softmax(logits: &mut [f32; C]) {
    let top = logits.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let mut total = 0.0;
    for l in logits.iter_mut() {
        *l = spade_classify::exp(*l - top);
        total += *l;
    }
    for l in logits.iter_mut() {
        *l /= total;
    }
}

pub fn train(data: &[(&[(u32, f32)], usize)], epochs: usize, seed: u64) -> Mlp {
    let mut rng = Rng::stream(seed, "mlp");
    let mut small = |scale: f32| (rng.below(2001) as f32 / 1000.0 - 1.0) * scale;
    let mut m = Mlp {
        w1: (0..BUCKETS * HIDDEN).map(|_| small(0.05)).collect(),
        b1: [0.01; HIDDEN],
        w2: [[0.0; C]; HIDDEN],
        b2: [0.0; C],
    };
    for row in m.w2.iter_mut() {
        for w in row.iter_mut() {
            *w = small(0.3);
        }
    }
    let mut g1 = vec![1e-6f32; BUCKETS * HIDDEN];
    let mut gb1 = [1e-6f32; HIDDEN];
    let mut g2 = [[1e-6f32; C]; HIDDEN];
    let mut gb2 = [1e-6f32; C];
    let mut counts = [0usize; C];
    for (_, label) in data {
        counts[*label] += 1;
    }
    let total = data.len().max(1) as f32;
    let weight: [f32; C] = std::array::from_fn(|c| {
        let balanced = if counts[c] == 0 {
            0.0
        } else {
            total / (C as f32 * counts[c] as f32)
        };
        balanced.sqrt()
            * if LOW_RISK.contains(&CLASSES[c]) {
                1.0
            } else {
                1.5
            }
    });
    let rate = 0.05f32;
    let mut order: Vec<usize> = (0..data.len()).collect();
    let mut shuffle = Rng::stream(seed, "mlp-order");
    for _ in 0..epochs {
        shuffle.shuffle(&mut order);
        for &i in &order {
            let (features, label) = data[i];
            let h = m.hidden(features);
            let mut p = m.b2;
            for (j, hj) in h.iter().enumerate() {
                for (c, pc) in p.iter_mut().enumerate() {
                    *pc += m.w2[j][c] * hj;
                }
            }
            softmax(&mut p);
            let d: [f32; C] =
                std::array::from_fn(|c| (p[c] - f32::from(u8::from(c == label))) * weight[label]);
            let mut dh = [0.0f32; HIDDEN];
            for j in 0..HIDDEN {
                if h[j] > 0.0 {
                    dh[j] = (0..C).map(|c| d[c] * m.w2[j][c]).sum();
                }
                for c in 0..C {
                    let g = d[c] * h[j];
                    g2[j][c] += g * g;
                    m.w2[j][c] -= rate * g / g2[j][c].sqrt();
                }
            }
            for c in 0..C {
                gb2[c] += d[c] * d[c];
                m.b2[c] -= rate * d[c] / gb2[c].sqrt();
            }
            for &(row, x) in features {
                let at = row as usize * HIDDEN;
                for j in 0..HIDDEN {
                    if dh[j] != 0.0 {
                        let g = dh[j] * x;
                        g1[at + j] += g * g;
                        m.w1[at + j] -= rate * g / g1[at + j].sqrt();
                    }
                }
            }
            for j in 0..HIDDEN {
                gb1[j] += dh[j] * dh[j];
                m.b1[j] -= rate * dh[j] / gb1[j].sqrt();
            }
        }
    }
    m
}
