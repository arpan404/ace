//! The member stamps: the daemon's answer stamp (`member-vector.json`, made by its own
//! `memberStamp`) verifies here byte for byte, and no stamp counts for another change, member,
//! role or domain.

use serde_json::Value;

use super::*;

fn vector() -> Value {
    serde_json::from_str(include_str!("../member-vector.json")).unwrap_or_default()
}

fn key(vector: &Value) -> Vec<u8> {
    let hex = vector["key"].as_str().unwrap_or_default();
    (0..hex.len())
        .step_by(2)
        .filter_map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect()
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

#[test]
fn the_daemons_answer_stamp_verifies_for_exactly_what_it_answered() {
    let v = vector();
    let key = key(&v);
    let at = v["at"].as_i64().unwrap_or_default();
    let answers = v["answers"].as_array().cloned().unwrap_or_default();
    assert_eq!(answers.len(), 3);
    for answer in &answers {
        let (target, value, stamp) = (
            text(&answer["target"]),
            text(&answer["value"]),
            text(&answer["stamp"]),
        );
        // Spade spells the target and value as the daemon does, from the route and its body.
        let body = &answer["body"];
        let spelled = answer_value(
            body["allowed"].as_bool().unwrap_or_default(),
            body["always"].as_bool().unwrap_or_default(),
        );
        assert_eq!(spelled, value);
        assert_eq!(
            sign_answer(&key, "user_01JSPADE", target, value, at, text(&v["nonce"])),
            stamp
        );
        let checked = check_answer(&key, stamp, target, value, at + 1_000);
        assert_eq!(
            checked.map(|(member, _)| member.account),
            Ok("user_01JSPADE".to_owned())
        );
    }
    assert_eq!(text(&answers[0]["target"]), approval_target("c_7", "k1"));
    assert_eq!(text(&answers[2]["target"]), outside_target("c_7", "o_2"));

    // Another call, another answer, too late, another key, another account in its place.
    let stamp = text(&answers[0]["stamp"]);
    let (target, value) = (text(&answers[0]["target"]), text(&answers[0]["value"]));
    let refused = [
        check_answer(&key, stamp, "approval:c_7:k2", value, at),
        check_answer(&key, stamp, target, "allowed=false;always=false", at),
        check_answer(&key, stamp, target, value, at + WINDOW_MS + 1),
        check_answer(
            b"another key, not the shared one!",
            stamp,
            target,
            value,
            at,
        ),
        check_answer(
            &key,
            &stamp.replace("user_01JSPADE", "user_01OTHER"),
            target,
            value,
            at,
        ),
    ];
    for (at, result) in refused.into_iter().enumerate() {
        assert!(result.is_err(), "case {at}");
    }
}

#[test]
fn no_stamp_stands_in_for_another_kind_of_stamp() {
    let v = vector();
    let key = key(&v);
    let at = v["at"].as_i64().unwrap_or_default();
    let nonce = text(&v["nonce"]);
    let member = Member {
        account: "user_01JSPADE".to_owned(),
        role: "admin".to_owned(),
        name: None,
    };
    let request = sign_request(&key, &member, "PUT /v1/agents/a_1/access", "ab", at, nonce);
    let ok = check_request(
        &key,
        &request,
        Some("admin"),
        "PUT /v1/agents/a_1/access",
        "ab",
        at,
    );
    assert_eq!(ok.map(|(m, _)| m), Ok(member.clone()));
    // A member can't call themselves an admin, nor an owner.
    for role in [None, Some("owner")] {
        assert!(
            check_request(&key, &request, role, "PUT /v1/agents/a_1/access", "ab", at).is_err()
        );
    }
    // An answer's stamp isn't a write's, a write's isn't an answer's, a person's is neither.
    let answer = sign_answer(&key, "user_01JSPADE", "approval:c_7:k1", "ab", at, nonce);
    assert!(check_request(&key, &answer, None, "approval:c_7:k1", "ab", at).is_err());
    assert!(check_answer(&key, &request, "PUT /v1/agents/a_1/access", "ab", at).is_err());
    let person = super::super::attest::sign(&key, "approval:c_7:k1", "ab", at, nonce);
    assert!(check_answer(&key, &person, "approval:c_7:k1", "ab", at).is_err());
}

#[test]
fn a_members_name_is_kept_on_one_short_line() {
    assert_eq!(name(Some(" Ana\nLee ")), Some("AnaLee".to_owned()));
    assert_eq!(name(Some("   ")), None);
    assert_eq!(name(Some(&"x".repeat(500))).map(|n| n.len()), Some(128));
}

#[test]
fn the_daemons_request_stamp_verifies_for_its_route_body_and_role_only() {
    let v = vector();
    let key = key(&v);
    let at = v["at"].as_i64().unwrap_or_default();
    let requests = v["requests"].as_array().cloned().unwrap_or_default();
    assert_eq!(requests.len(), 3);
    for request in &requests {
        let (method, path, body, role, stamp) = (
            text(&request["method"]),
            text(&request["path"]),
            text(&request["body"]),
            text(&request["role"]),
            text(&request["stamp"]),
        );
        // Spade signs the path it routes, without the query, and the body's digest.
        let target = format!("{method} {}", path.split('?').next().unwrap_or_default());
        let value = spade_core::org::audit::digest(body.as_bytes());
        let (member, _) = check_request(&key, stamp, Some(role), &target, &value, at)
            .unwrap_or_else(|bad| panic!("{target}: {bad:?}"));
        assert_eq!(member.account, "user_01JSPADE");
        assert_eq!(member.role, role);
        // Another route, another body or another role: no stamp of the daemon's counts there.
        let elsewhere = format!("{method} /v1/agents/a_2/access");
        assert!(check_request(&key, stamp, Some(role), &elsewhere, &value, at).is_err());
        let other = spade_core::org::audit::digest(b"{}");
        assert!(check_request(&key, stamp, Some(role), &target, &other, at).is_err());
        assert!(check_request(&key, stamp, Some("owner"), &target, &value, at).is_err());
    }
}
