//! `exp` written out in plain f32 arithmetic, so the classifier's probabilities, and the weights
//! `classify-train` writes, are the same bits on every machine and with every C library: the
//! platform's `exp` may differ in its last bit from one system to another, which could move a
//! call across a threshold or change a trained file.

/// `e^x`, within a few units in the last place, the same everywhere. Below about -87 it is 0.
pub fn exp(x: f32) -> f32 {
    const LN2_HI: f32 = 0.693_145_75;
    const LN2_LO: f32 = 1.428_606_8e-6;
    const LOG2E: f32 = std::f32::consts::LOG2_E;
    if x.is_nan() {
        return x;
    }
    if x < -87.0 {
        return 0.0;
    }
    let x = x.min(88.0);
    let n = (x * LOG2E).round();
    // The remainder, |r| ≤ ln 2 / 2, in two steps so it loses no precision.
    let r = (x - n * LN2_HI) - n * LN2_LO;
    let p = 1.0
        + r * (1.0
            + r * (0.5
                + r * (1.0 / 6.0
                    + r * (1.0 / 24.0 + r * (1.0 / 120.0 + r * (1.0 / 720.0 + r / 5040.0))))));
    let n = n as i32;
    if n < -126 {
        return 0.0;
    }
    p * f32::from_bits(((n + 127) as u32) << 23)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_matches_the_platforms_exp_to_a_few_parts_in_ten_million() {
        let mut x = -87.0f32;
        while x < 88.0 {
            let (ours, theirs) = (exp(x), x.exp());
            assert!(
                (ours - theirs).abs() <= theirs * 4e-7,
                "{x}: {ours} against {theirs}"
            );
            x += 0.0137;
        }
        assert_eq!(exp(0.0), 1.0);
        assert_eq!(exp(-200.0), 0.0);
    }
}
