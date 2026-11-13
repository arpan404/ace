//! Shuffle: well-formed faces weighted toward the friendlier ones, step for step as the TS model
//! does it, so one seed makes one face in both.

use super::{
    ACCESSORY, BODY, CHEEKS, EARS, FIELDS, Face, MARKING, MOUTH, PAIR, Seeded, allowed, settle,
};

const BODY_WEIGHTS: &[(&str, u32)] = &[
    ("round", 18),
    ("blob", 10),
    ("pebble", 8),
    ("sprout", 8),
    ("ghost", 9),
    ("bot", 8),
    ("fox", 9),
    ("bird", 9),
    ("cloud", 8),
    ("bean", 8),
];

/// Bodies that look best in a few pairs; the rest take any.
const PAIRS_FOR: &[(&str, &[&str])] = &[
    ("ghost", &["stone", "lilac", "mint", "sky"]),
    ("sprout", &["mint", "sage", "butter", "lagoon"]),
    ("fox", &["ember", "cocoa", "butter", "berry"]),
    ("bird", &["sky", "lagoon", "butter", "berry", "rose"]),
    ("bot", &["stone", "sky", "lagoon", "mint", "butter"]),
    ("cloud", &["sky", "lilac", "stone", "rose"]),
];

const EYES_WEIGHTS: &[(&str, u32)] = &[
    ("egg", 30),
    ("round", 20),
    ("big", 20),
    ("sleepy", 10),
    ("almond", 10),
    ("bead", 10),
];
const MOUTH_WEIGHTS: &[(&str, u32)] = &[
    ("none", 35),
    ("smile", 25),
    ("cat", 12),
    ("o", 8),
    ("open", 12),
    ("grin", 8),
];
const CHEEKS_WEIGHTS: &[(&str, u32)] = &[("none", 45), ("blush", 40), ("freckles", 15)];
const DECORATION_COUNT: &[(&str, u32)] = &[("0", 25), ("1", 45), ("2", 30)];
const DECORATIONS: [usize; 3] = [EARS, MARKING, ACCESSORY];
const MAX_DECORATIONS: usize = 2;
/// Species with features of their own take one decoration at most.
const ONE_DECORATION: &[&str] = &["sprout", "bot", "fox", "bird"];

fn pick<T: Copy>(random: &mut Seeded, list: &[T]) -> T {
    let at = (random.float() * list.len() as f64).floor() as usize;
    list[at.min(list.len() - 1)]
}

fn weighted(random: &mut Seeded, table: &[(&'static str, u32)]) -> &'static str {
    let total: u32 = table.iter().map(|(_, weight)| weight).sum();
    let mut left = random.float() * f64::from(total);
    for (value, weight) in table {
        left -= f64::from(*weight);
        if left < 0.0 {
            return value;
        }
    }
    table[0].0
}

/// A new face: a body other than `current`'s by weight, a pair (preferring ones not in `taken`),
/// eyes, mouth and cheeks by weight, and up to two decorations from the values allowed at that
/// moment. Freckles become blush beside a decoration. Always valid.
pub fn shuffle(random: &mut Seeded, current: Option<&Face>, taken: &[&str]) -> Face {
    let bodies: Vec<(&'static str, u32)> = BODY_WEIGHTS
        .iter()
        .copied()
        .filter(|(body, _)| current.is_none_or(|face| face.0[BODY] != *body))
        .collect();
    let body = weighted(random, &bodies);
    let pool: Vec<&'static str> = PAIRS_FOR
        .iter()
        .find(|(of, _)| *of == body)
        .map_or(FIELDS[PAIR].1, |(_, pairs)| *pairs)
        .iter()
        .copied()
        .filter(|pair| current.is_none_or(|face| face.0[PAIR] != *pair))
        .collect();
    let free: Vec<&'static str> = pool
        .iter()
        .copied()
        .filter(|pair| !taken.contains(pair))
        .collect();
    let pair = if !free.is_empty() {
        pick(random, &free)
    } else if !pool.is_empty() {
        pick(random, &pool)
    } else {
        pick(random, FIELDS[PAIR].1)
    };
    let mut face = Face::default();
    face.0[BODY] = body;
    face.0[PAIR] = pair;
    face.0[super::EYES_FIELD] = weighted(random, EYES_WEIGHTS);
    face.0[CHEEKS] = weighted(random, CHEEKS_WEIGHTS);
    if allowed(MOUTH, &face).len() > 1 {
        face.0[MOUTH] = weighted(random, MOUTH_WEIGHTS);
    }
    let cap = if ONE_DECORATION.contains(&body) {
        1
    } else {
        MAX_DECORATIONS
    };
    let budget = weighted(random, DECORATION_COUNT)
        .parse::<usize>()
        .unwrap_or(0)
        .min(cap);
    let mut slots = DECORATIONS;
    for index in (1..slots.len()).rev() {
        let other = ((random.float() * (index + 1) as f64).floor() as usize).min(index);
        slots.swap(index, other);
    }
    let mut used = 0;
    for slot in slots {
        if used >= budget {
            break;
        }
        let values: Vec<&'static str> = allowed(slot, &face)
            .into_iter()
            .filter(|value| *value != "none")
            .collect();
        if values.is_empty() {
            continue;
        }
        face.0[slot] = pick(random, &values);
        used += 1;
    }
    if used > 0 && face.0[CHEEKS] == "freckles" {
        face.0[CHEEKS] = "blush";
    }
    settle(face, None)
}

/// The face an agent without one gets: a shuffle seeded by its id, the same in every client.
pub fn face_for_id(id: &str, taken: &[&str]) -> Face {
    shuffle(&mut Seeded::from_text(id), None, taken)
}
