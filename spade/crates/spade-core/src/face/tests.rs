use serde_json::{Value, json};

use super::*;

type Outcome = Result<(), Box<dyn std::error::Error>>;

/// The vectors the TS model answers too (`packages/ui-core/src/bot-face/vectors.test.ts`).
const VECTORS: &str = include_str!("vectors.json");

fn expected(output: &Value) -> Result<Face, String> {
    let mut face = Face::default();
    for (at, (field, values)) in FIELDS.iter().enumerate() {
        let given = output[*field].as_str().unwrap_or_default();
        face.0[at] = values
            .iter()
            .find(|v| **v == given)
            .ok_or(format!("{field}: {given} is not a value"))?;
    }
    Ok(face)
}

fn vectors() -> Result<Value, serde_json::Error> {
    serde_json::from_str(VECTORS)
}

#[test]
fn repair_gives_the_same_face_as_the_ts_model_for_every_shared_vector() -> Outcome {
    let vectors = vectors()?;
    let cases = vectors["repair"].as_array().ok_or("no repair cases")?;
    assert!(cases.len() >= 40);
    for case in cases {
        assert_eq!(
            repair(&case["input"]),
            expected(&case["output"])?,
            "{}",
            case["input"]
        );
    }
    Ok(())
}

#[test]
fn an_id_seeds_the_same_face_as_the_ts_model() -> Outcome {
    let vectors = vectors()?;
    for case in vectors["seeded"].as_array().ok_or("no seeded cases")? {
        let taken: Vec<&str> = case["taken"]
            .as_array()
            .map(|t| t.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        assert_eq!(
            face_for_id(case["id"].as_str().unwrap_or_default(), &taken),
            expected(&case["output"])?,
            "{}",
            case["id"]
        );
    }
    Ok(())
}

#[test]
fn garbage_always_repairs_to_a_valid_face() {
    let mut random = Seeded::from_text("garbage");
    let junk = [
        json!(null),
        json!(3),
        json!("cat"),
        json!(["round"]),
        json!({}),
    ];
    for _ in 0..2000 {
        let mut raw = serde_json::Map::new();
        for (field, values) in FIELDS {
            let roll = random.float();
            let value = if roll < 0.7 {
                json!(values[(random.float() * values.len() as f64) as usize % values.len()])
            } else {
                junk[(random.float() * junk.len() as f64) as usize % junk.len()].clone()
            };
            raw.insert(field.into(), value);
        }
        assert!(is_valid(&repair(&Value::Object(raw))));
    }
    assert!(is_valid(&repair(&json!("not an object"))));
}

#[test]
fn shuffles_keep_every_body_rule_and_exclusion_and_at_most_two_decorations() {
    for seed in 0..3000 {
        let mut random = Seeded::from_text(&format!("seed-{seed}"));
        let current = shuffle(&mut random, None, &[]);
        let face = shuffle(&mut random, Some(&current), &[]);
        assert!(is_valid(&face), "{face:?}");
        assert_ne!(face.0[BODY], current.0[BODY]);
        let decorations = [EARS, MARKING, ACCESSORY]
            .iter()
            .filter(|f| face.0[**f] != "none")
            .count();
        let cap = if ["sprout", "bot", "fox", "bird"].contains(&face.0[BODY]) {
            1
        } else {
            2
        };
        assert!(decorations <= cap, "{face:?}");
        if decorations > 0 {
            assert_ne!(face.0[CHEEKS], "freckles");
        }
    }
}

#[test]
fn shuffle_prefers_a_pair_no_other_bot_wears() {
    let taken = ["ember", "butter", "mint", "lagoon", "sky", "lilac", "rose"];
    for seed in 0..500 {
        let face = face_for_id(&format!("bot-{seed}"), &taken);
        let body_list = ["ghost", "sprout", "fox", "bird", "bot", "cloud"];
        // A body with its own short list may have every pair taken; the others always find one.
        if !body_list.contains(&face.0[BODY]) {
            assert!(!taken.contains(&face.0[PAIR]), "{face:?}");
        }
    }
}

#[test]
fn a_stored_face_reads_back_as_itself() {
    let face = face_for_id("bot-7", &[]);
    assert_eq!(repair(&face.to_json()), face);
    assert_eq!(face.to_json()["kind"], "character");
    assert_eq!(face.to_json()["v"], 1);
}
