//! A policy statement made by the backend's own `signOrgPolicy` (`policy-vector.json`) verifies
//! here, and every change to it is refused.

use serde_json::Value;

use super::*;

struct Vector {
    keys: Vec<GrantKey>,
    org: String,
    body: String,
    statement: String,
}

fn vector() -> Vector {
    let raw: Value =
        serde_json::from_str(include_str!("../policy-vector.json")).expect("the vector");
    Vector {
        keys: serde_json::from_value(raw["keys"].clone()).expect("keys"),
        org: raw["org"].as_str().expect("org").to_owned(),
        body: raw["body"].as_str().expect("body").to_owned(),
        statement: raw["statement"].as_str().expect("statement").to_owned(),
    }
}

#[test]
fn the_backends_statement_verifies_with_its_grant_key() {
    let v = vector();
    let statement = verify(&v.statement, &v.keys, &v.body, &v.org).expect("verified");
    assert_eq!(statement.version, 4);
    assert_eq!(statement.set_by, "user_01JSPADE");
}

#[test]
fn a_policy_with_a_bad_signature_another_key_another_body_or_org_is_refused() {
    let v = vector();
    let (claims, signature) = v.statement.split_once('.').expect("two parts");
    // One character of the signature changed.
    let last = signature.chars().last().expect("a character");
    let flipped = format!(
        "{claims}.{}{}",
        &signature[..signature.len() - 1],
        if last == 'A' { 'B' } else { 'A' }
    );
    assert_eq!(
        verify(&flipped, &v.keys, &v.body, &v.org),
        Err(Refused::Signature)
    );
    // Claims respelled to a higher version: the signature is over the old ones.
    let raised = String::from_utf8(URL_SAFE_NO_PAD.decode(claims).expect("claims"))
        .expect("text")
        .replace("\"version\":4", "\"version\":9");
    let forged = format!("{}.{signature}", URL_SAFE_NO_PAD.encode(raised));
    assert_eq!(
        verify(&forged, &v.keys, &v.body, &v.org),
        Err(Refused::Signature)
    );
    // A key this host never pinned.
    let other = vec![GrantKey {
        id: "k3".to_owned(),
        public_key: "5AMJmM_VrRcjwWn5VqoLnrhhm1mSvWEsKvQo68efjfA".to_owned(),
    }];
    assert_eq!(
        verify(&v.statement, &other, &v.body, &v.org),
        Err(Refused::Signature)
    );
    assert_eq!(
        verify(&v.statement, &[], &v.body, &v.org),
        Err(Refused::UnknownKey)
    );
    // A body widened after signing.
    assert_eq!(
        verify(&v.statement, &v.keys, "{}", &v.org),
        Err(Refused::Body)
    );
    assert_eq!(
        verify(&v.statement, &v.keys, &v.body, "org_other"),
        Err(Refused::OtherOrg)
    );
    for malformed in ["", "x", "a.b.c", &format!("{claims}.")] {
        assert!(
            verify(malformed, &v.keys, &v.body, &v.org).is_err(),
            "{malformed}"
        );
    }
}
