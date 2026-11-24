// SPDX-License-Identifier: Apache-2.0
//! JavaScript's answers, pinned. Each expected string is what Node 26 and Bun 1.4 print for
//! `JSON.stringify(JSON.parse(input))`, recorded with
//! `node -e 'for (const c of cases) console.log(JSON.stringify([c, JSON.stringify(JSON.parse(c))]))'`
//! (Node, because Bun's transpiler rewrites `😀` inside `String.raw`; its
//! `JSON.parse` gives the same answers when the text is built at run time).

use crate::{Value, json, parse, parse_raw, ser, to_string};

/// (input, `JSON.stringify(JSON.parse(input))`)
const ROUND_TRIPS: &[(&str, &str)] = &[
    // Lone surrogates survive; escaped pairs join; adjacent strings never join.
    (r#""\ud800""#, r#""\ud800""#),
    (r#""😀""#, "\"\u{1f600}\""),
    (r#""a\udc00b""#, r#""a\udc00b""#),
    (r#"["\ud83d","\ude00"]"#, r#"["\ud83d","\ude00"]"#),
    (r#""\ud83dA""#, r#""\ud83dA""#),
    (r#""\udc00\ud800""#, r#""\udc00\ud800""#),
    // Number::toString.
    ("1e20", "100000000000000000000"),
    ("1e21", "1e+21"),
    ("1.000", "1"),
    ("-0", "0"),
    ("0.1", "0.1"),
    ("1.5e-7", "1.5e-7"),
    ("0.000001", "0.000001"),
    ("1e-7", "1e-7"),
    ("123456789012345678901234567890", "1.2345678901234568e+29"),
    ("9007199254740993", "9007199254740992"),
    ("1e400", "null"),
    ("5e-324", "5e-324"),
    ("0.30000000000000004", "0.30000000000000004"),
    ("-1.5E+3", "-1500"),
    ("2.5e+300", "2.5e+300"),
    (
        "[-0.0,100,1e15,123e-20]",
        "[0,100,1000000000000000,1.23e-18]",
    ),
    // QuoteJSONString: short escapes, lowercase \u00xx, DEL, U+2028 and `/` raw.
    (
        r#""\u000a\u0007\u001f\u007f /\/""#,
        "\"\\n\\u0007\\u001f\u{7f}\u{2028}//\"",
    ),
    (r#""\"\\\b\f\t\r""#, r#""\"\\\b\f\t\r""#),
    (r#"{"\u000a\"":1}"#, r#"{"\n\"":1}"#),
    // Duplicate keys: last value, first place. `__proto__` is an own key.
    (r#"{"a":1,"b":2,"a":3}"#, r#"{"a":3,"b":2}"#),
    (
        r#"{"__proto__":{"x":1},"y":2}"#,
        r#"{"__proto__":{"x":1},"y":2}"#,
    ),
    // Array-index keys first, ascending; then the rest in insertion order.
    (
        r#"{"b":1,"2":2,"1":3,"a":4,"01":5,"4294967295":6,"4294967294":7}"#,
        r#"{"1":3,"2":2,"4294967294":7,"b":1,"a":4,"01":5,"4294967295":6}"#,
    ),
    (
        r#" { "a" : [ 1 , 2 ] , "b" : { } } "#,
        r#"{"a":[1,2],"b":{}}"#,
    ),
];

/// Inputs `JSON.parse` rejects with a SyntaxError.
const REJECTED: &[&str] = &[
    "[1,]",
    "01",
    "{'a':1}",
    r#""\x""#,
    "[1] x",
    "\"a\u{0}\"",
    ".5",
    "+1",
    "NaN",
    "",
    r#"{"a" 1}"#,
    "[1 2]",
    r#""\ud800"#,
    "tru",
];

#[test]
fn parse_then_stringify_matches_javascript() {
    for (input, expected) in ROUND_TRIPS {
        let value = parse(input).unwrap_or_else(|error| panic!("{input}: {error}"));
        assert_eq!(to_string(&value), *expected, "tree of {input}");
        let raw = parse_raw(input).unwrap_or_else(|error| panic!("{input}: {error}"));
        let mut spliced = String::new();
        raw.write_to(&mut spliced);
        assert_eq!(spliced, *expected, "splice of {input}");
        assert_eq!(raw.is_canonical(), input == expected, "canonical {input}");
    }
}

#[test]
fn rejects_what_json_parse_rejects() {
    for input in REJECTED {
        assert!(parse(input).is_err(), "parsed {input:?}");
        assert!(parse_raw(input).is_err(), "validated {input:?}");
    }
}

#[test]
fn borrowed_reads_take_the_last_duplicate_and_decode_escapes() {
    let raw = parse_raw(r#"{"a":1, "key":"x\ty", "a":[true,null]}"#)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(raw.get("a").map(|a| a.text()), Some("[true,null]"));
    assert_eq!(
        raw.get("key").and_then(|k| k.as_str()).as_deref(),
        Some("x\ty")
    );
    assert_eq!(
        raw.get("a").and_then(|a| a.at(1)).map(|n| n.is_null()),
        Some(true)
    );
}

#[test]
fn hundred_thousand_deep_arrays_parse_serialize_clone_and_drop() {
    let depth = 100_000;
    let text = format!("{}{}", "[".repeat(depth), "]".repeat(depth));
    let value = parse(&text).unwrap_or_else(|error| panic!("{error}"));
    let copy = value.clone();
    assert!(copy == value);
    assert_eq!(to_string(&copy), text);
    assert!(parse_raw(&text).is_ok_and(|raw| raw.is_canonical()));
    drop(copy);
    drop(value);
    let objects = format!("{}1{}", r#"{"a":"#.repeat(depth), "}".repeat(depth));
    let value = parse(&objects).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(to_string(&value), objects);
}

#[test]
fn derived_structs_and_built_values_serialize_like_json_stringify() {
    #[derive(serde::Serialize)]
    struct Usage<'a> {
        tokens: u64,
        cost: f64,
        ratio: f64,
        label: &'a str,
        skipped: Option<u8>,
        data: crate::Raw,
    }
    let usage = Usage {
        tokens: 9_007_199_254_740_993,
        cost: 1.0,
        ratio: f64::NAN,
        label: "a\nb",
        skipped: None,
        data: crate::Raw::from_json(r#"{ "z" : 1e21 }"#).unwrap_or_default(),
    };
    assert_eq!(
        ser::to_string(&usage).ok().as_deref(),
        Some(
            r#"{"tokens":9007199254740992,"cost":1,"ratio":null,"label":"a\nb","skipped":null,"data":{"z":1e+21}}"#
        )
    );
    let built: Value = json!({"b": 1, "1": [null, -0.0, "\u{2028}"], "a": {}});
    assert_eq!(
        to_string(&built),
        "{\"1\":[null,0,\"\u{2028}\"],\"b\":1,\"a\":{}}"
    );
}

/// A `String` field that carries a Rust-text string back out: a string holding the escape
/// marker itself and a lone surrogate keeps both, and writes back as the same JSON.
#[test]
fn rust_text_round_trips_a_marker_and_a_lone_surrogate() {
    #[derive(serde::Deserialize, serde::Serialize)]
    struct Text {
        text: String,
    }
    let mixed = r#"{"text":"\ue000\ud800\ue000"}"#;
    let value = parse(mixed).expect("parses");
    let decoded: Text = crate::from_value(&value).expect("decodes into Rust text");
    // JSON.stringify leaves U+E000 literal and escapes the lone surrogate.
    assert_eq!(
        ser::to_string(&decoded).ok().as_deref(),
        Some("{\"text\":\"\u{e000}\\ud800\u{e000}\"}")
    );
}
