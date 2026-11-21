//! An org host for the organization tests (ADR 0206): this Spade given to Acme with its owner's
//! stamp, requests stamped as ace's daemon stamps a member's, and policies signed with the grant
//! key of `src/org/policy-vector.json` (Ed25519 seed 0x03 × 32, as the backend's own vectors).

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use spade_core::org::Member;

use super::{Result, Spade, TOKEN};

pub const ORG: &str = "org_01JSPADETEAM";
pub const HOST: &str = "HOSTACME";

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| {
            i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
        })
}

fn nonce() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

pub fn member(account: &str, role: &str) -> Member {
    Member {
        account: account.to_owned(),
        role: role.to_owned(),
        name: None,
    }
}

/// The backend's grant keys, as the vector has them.
pub fn keys() -> Value {
    let vector: Value =
        serde_json::from_str(include_str!("../../src/org/policy-vector.json")).unwrap_or_default();
    vector["keys"].clone()
}

/// Gives `spade` to Acme, with its owner's stamp made with `person_key`.
pub async fn bind(spade: &Spade, person_key: &[u8]) -> Result<Value> {
    bind_to(spade, person_key, ORG, "Acme").await
}

/// Gives `spade` to organization `org`, called `name`.
pub async fn bind_to(spade: &Spade, person_key: &[u8], org: &str, name: &str) -> Result<Value> {
    let stamp = spade_server::security::attest::sign(person_key, "org", org, now_ms(), &nonce());
    let (status, body) = spade
        .put_with(
            "/v1/org",
            json!({ "org": org, "name": name, "host": HOST, "keys": keys() }),
            &[(spade_server::security::attest::HEADER, &stamp)],
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    Ok(body)
}

/// Writes Acme's binding straight into `spade`'s settings, as a host given to it keeps it: for
/// a Spade whose security service has no person key to check the owner's stamp with.
pub fn bind_directly(spade: &Spade) -> Result {
    let binding = json!({ "org": ORG, "name": "Acme", "host": HOST, "keys": keys() });
    spade_store::Store::connect(spade.database())?.execute(
        "INSERT INTO settings (key, value) VALUES ('org', ?1)",
        [binding.to_string()],
    )?;
    Ok(())
}

/// `method path` with `body` as `member`, stamped by ace's daemon with `person_key`, over the
/// request itself; `None` sends it with no stamp.
pub async fn as_member(
    spade: &Spade,
    person_key: &[u8],
    member: Option<&Member>,
    method: reqwest::Method,
    path: &str,
    body: &Value,
) -> Result<(u16, Value)> {
    let bytes = serde_json::to_vec(body)?;
    let mut request = spade
        .http
        .request(method.clone(), format!("{}{path}", spade.base))
        .bearer_auth(TOKEN)
        .header("content-type", "application/json")
        .body(bytes.clone());
    if let Some(member) = member {
        let target = format!("{method} {path}");
        let value = spade_core::org::audit::digest(&bytes);
        let stamp = spade_server::security::member::sign_request(
            person_key,
            member,
            &target,
            &value,
            now_ms(),
            &nonce(),
        );
        request = request
            .header(spade_server::security::member::REQUEST_HEADER, stamp)
            .header(spade_server::security::member::ROLE_HEADER, &member.role)
            .header(spade_server::security::member::NAME_HEADER, "A member");
    }
    let response = request.send().await?;
    let status = response.status().as_u16();
    let text = response.text().await?;
    Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
}

/// A shared bot `name` made by `maker`: its id and conversation.
pub async fn shared_bot(
    spade: &Spade,
    person_key: &[u8],
    maker: &Member,
    name: &str,
) -> Result<(String, String)> {
    let (status, made) = as_member(
        spade,
        person_key,
        Some(maker),
        reqwest::Method::POST,
        "/v1/org/bots",
        &json!({ "name": name, "task": "Watch CI.", "model": "fake/m" }),
    )
    .await?;
    assert_eq!(status, 201, "{made}");
    let id = made["agent"]["id"].as_str().unwrap_or_default().to_owned();
    let (_, view) = spade.get("/v1/agents").await?;
    let conversation = view["agents"]
        .as_array()
        .and_then(|agents| agents.iter().find(|a| a["id"] == id.as_str()))
        .and_then(|agent| agent["conversation"].as_str())
        .unwrap_or_default()
        .to_owned();
    Ok((id, conversation))
}

/// One policy version over `body`, signed with the vector's grant key.
pub fn policy(version: u64, body: &str) -> Value {
    policy_for(ORG, version, body)
}

/// [`policy`] for organization `org`.
pub fn policy_for(org: &str, version: u64, body: &str) -> Value {
    let claims = json!({
        "v": 1, "kid": "k3", "kind": "org-policy", "org": org, "version": version,
        "body_sha256": spade_core::org::audit::digest(body.as_bytes()),
        "set_by": "user_admin", "set_at": 1_800_000_000_000u64,
    });
    let bytes = claims.to_string().into_bytes();
    let signature = ring::signature::Ed25519KeyPair::from_seed_unchecked(&[3u8; 32])
        .map(|pair| URL_SAFE_NO_PAD.encode(pair.sign(&bytes).as_ref()))
        .unwrap_or_default();
    json!({
        "org": org,
        "version": version,
        "body": body,
        "statement": format!("{}.{signature}", URL_SAFE_NO_PAD.encode(&bytes)),
    })
}

/// Applies `offered` on `spade`: its status and answer.
pub async fn offer(spade: &Spade, offered: &Value) -> Result<(u16, Value)> {
    spade.put("/v1/org/policy", offered.clone()).await
}

/// The host's audit log, exported.
pub async fn export(spade: &Spade) -> Result<String> {
    let response = spade
        .http
        .get(format!("{}/v1/org/audit/export", spade.base))
        .bearer_auth(TOKEN)
        .send()
        .await?;
    assert_eq!(response.status().as_u16(), 200);
    Ok(response.text().await?)
}

/// The entries of an export with `action`, as JSON.
pub fn entries(export: &str, action: &str) -> Vec<Value> {
    export
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|line| line["kind"] == "entry" && line["action"] == action)
        .collect()
}

/// An answer to `call` in `conversation`, stamped as ace's daemon stamps a member's answer
/// (`apps/daemon/src/spade/member-stamp.ts`): over the request it answers and what it says, with
/// the member's account; `None` sends it unstamped.
pub async fn answer(
    spade: &Spade,
    person_key: &[u8],
    account: Option<&str>,
    conversation: &str,
    call: &str,
    allowed: bool,
) -> Result<u16> {
    let mut request = spade
        .http
        .post(format!(
            "{}/v1/conversations/{conversation}/approvals/{call}",
            spade.base
        ))
        .bearer_auth(TOKEN)
        .json(&json!({ "allowed": allowed }));
    if let Some(account) = account {
        let stamp = spade_server::security::member::sign_answer(
            person_key,
            account,
            &spade_server::security::member::approval_target(conversation, call),
            &spade_server::security::member::answer_value(allowed, false),
            now_ms(),
            &nonce(),
        );
        request = request.header(spade_server::security::member::HEADER, stamp);
    }
    Ok(request.send().await?.status().as_u16())
}
