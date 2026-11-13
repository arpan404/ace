//! A bot's character face: eight stored fields from which every client draws the face. The
//! same tables and rules live in `packages/ui-core/src/bot-face/`; `face-vectors.json` pins the
//! two to the same answers for repair and for the face an id seeds. Pure: randomness is passed in.

use serde_json::{Map, Value, json};

/// The model version a stored face carries as `v`.
pub const VERSION: u64 = 1;

/// The fields in order, each with its values; the first is the default for all but `pair`.
pub const FIELDS: [(&str, &[&str]); 8] = [
    (
        "body",
        &[
            "round", "blob", "pebble", "sprout", "ghost", "bot", "fox", "bird", "cloud", "bean",
        ],
    ),
    (
        "pair",
        &[
            "ember", "butter", "mint", "lagoon", "sky", "lilac", "rose", "berry", "sage", "cocoa",
            "stone",
        ],
    ),
    ("ears", &["none", "cat", "bear", "bunny", "tuft", "nubs"]),
    (
        "marking",
        &["none", "cap", "mask", "muzzle", "patch", "stripes", "spots"],
    ),
    ("eyes", &["egg", "round", "big", "sleepy", "almond", "bead"]),
    ("mouth", &["none", "smile", "open", "cat", "o", "grin"]),
    ("cheeks", &["none", "blush", "freckles"]),
    (
        "accessory",
        &[
            "none",
            "bow",
            "flower",
            "glasses",
            "headphones",
            "beanie",
            "scarf",
        ],
    ),
];

const BODY: usize = 0;
const PAIR: usize = 1;
const EARS: usize = 2;
const MARKING: usize = 3;
const EYES_FIELD: usize = 4;
const MOUTH: usize = 5;
const CHEEKS: usize = 6;
const ACCESSORY: usize = 7;

const DEFAULT_PAIR: &str = "lagoon";

/// What a body narrows: (body, field, the whole allowed set). Unlisted fields are open.
const BODY_LIMITS: &[(&str, usize, &[&str])] = &[
    ("blob", EARS, &["none", "cat", "bear", "bunny", "nubs"]),
    (
        "blob",
        MARKING,
        &["none", "cap", "mask", "muzzle", "patch", "spots"],
    ),
    ("sprout", EARS, &["none"]),
    (
        "sprout",
        MARKING,
        &["none", "mask", "muzzle", "patch", "spots"],
    ),
    (
        "sprout",
        ACCESSORY,
        &["none", "glasses", "headphones", "scarf"],
    ),
    (
        "ghost",
        ACCESSORY,
        &["none", "bow", "flower", "glasses", "headphones", "beanie"],
    ),
    ("bot", EARS, &["none"]),
    ("bot", MARKING, &["none", "cap", "stripes", "spots"]),
    ("bot", ACCESSORY, &["none", "bow", "flower", "scarf"]),
    ("fox", EARS, &["none"]),
    (
        "fox",
        MARKING,
        &["none", "mask", "patch", "stripes", "spots"],
    ),
    ("fox", ACCESSORY, &["none", "flower", "glasses", "scarf"]),
    ("bird", EARS, &["none"]),
    ("bird", MARKING, &["none", "cap", "mask", "patch", "spots"]),
    ("bird", MOUTH, &["none"]),
    (
        "bird",
        ACCESSORY,
        &["none", "bow", "flower", "glasses", "headphones", "scarf"],
    ),
    ("cloud", EARS, &["none", "cat", "bear", "bunny"]),
    (
        "cloud",
        ACCESSORY,
        &["none", "bow", "flower", "glasses", "beanie", "scarf"],
    ),
];

/// Values that never appear together: (field, values, other field, values).
const EXCLUSIONS: &[(usize, &[&str], usize, &[&str])] = &[
    (
        EARS,
        &["cat", "bear", "bunny"],
        ACCESSORY,
        &["headphones", "bow", "flower", "beanie"],
    ),
    (EARS, &["tuft", "nubs"], ACCESSORY, &["beanie"]),
    (EARS, &["tuft"], MARKING, &["stripes"]),
    (MARKING, &["mask", "patch"], ACCESSORY, &["glasses"]),
    (MARKING, &["cap"], ACCESSORY, &["beanie"]),
    (MARKING, &["spots"], CHEEKS, &["freckles"]),
];

/// A face: one value per field, in `FIELDS` order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Face(pub [&'static str; 8]);

impl Default for Face {
    fn default() -> Self {
        let mut values = FIELDS.map(|(_, values)| values[0]);
        values[PAIR] = DEFAULT_PAIR;
        Face(values)
    }
}

impl Face {
    /// The value of the field named `name`.
    pub fn get(&self, name: &str) -> Option<&'static str> {
        FIELDS
            .iter()
            .position(|(field, _)| *field == name)
            .map(|at| self.0[at])
    }

    /// The face as stored: `{"kind":"character","v":1, ...fields}`.
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("kind".into(), json!("character"));
        out.insert("v".into(), json!(VERSION));
        for (at, (field, _)) in FIELDS.iter().enumerate() {
            out.insert((*field).into(), json!(self.0[at]));
        }
        Value::Object(out)
    }
}

/// The values of field `field` allowed on `face`: the body's set minus exclusions.
pub fn allowed(field: usize, face: &Face) -> Vec<&'static str> {
    let mut values: Vec<&'static str> = FIELDS[field].1.to_vec();
    if let Some((_, _, limit)) = BODY_LIMITS
        .iter()
        .find(|(body, at, _)| *body == face.0[BODY] && *at == field)
    {
        values.retain(|value| limit.contains(value));
    }
    for (when, when_values, never, never_values) in EXCLUSIONS {
        if field == *never && when_values.contains(&face.0[*when]) {
            values.retain(|value| !never_values.contains(value));
        }
        if field == *when && never_values.contains(&face.0[*never]) {
            values.retain(|value| !when_values.contains(value));
        }
    }
    values
}

/// Whether every field holds a value allowed on the face.
pub fn is_valid(face: &Face) -> bool {
    (0..FIELDS.len()).all(|field| allowed(field, face).contains(&face.0[field]))
}

/// Every field but `kept` (and body and pair) that is no longer allowed takes its first allowed
/// value: `none` for every optional field.
pub fn settle(mut face: Face, kept: Option<usize>) -> Face {
    for _ in 0..3 {
        for field in 0..FIELDS.len() {
            if Some(field) == kept || field == BODY || field == PAIR {
                continue;
            }
            let values = allowed(field, &face);
            if !values.contains(&face.0[field]) {
                face.0[field] = values[0];
            }
        }
    }
    face
}

/// Any stored or sent face as a valid one: unknown or missing values take the default, then the
/// rules repair the rest. Never fails, so whatever was stored always draws.
pub fn repair(raw: &Value) -> Face {
    let mut face = Face::default();
    for (at, (field, values)) in FIELDS.iter().enumerate() {
        if let Some(found) = raw[*field]
            .as_str()
            .and_then(|given| values.iter().find(|value| **value == given))
        {
            face.0[at] = found;
        }
    }
    settle(face, None)
}

/// Mulberry32: a small seeded generator the TS model computes bit for bit.
pub struct Seeded(u32);

impl Seeded {
    /// Seeded by FNV-1a over `text`'s UTF-8 bytes.
    pub fn from_text(text: &str) -> Self {
        Seeded(text.bytes().fold(0x811c_9dc5_u32, |hash, byte| {
            (hash ^ u32::from(byte)).wrapping_mul(0x0100_0193)
        }))
    }

    /// A number in [0, 1).
    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let s = self.0;
        let mut t = (s ^ (s >> 15)).wrapping_mul(1 | s);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

mod shuffle;
pub use shuffle::{face_for_id, shuffle};

#[cfg(test)]
mod tests;
