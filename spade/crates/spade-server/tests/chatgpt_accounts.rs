//! ChatGPT accounts through the API (ADR 0214): a sign-in becomes an account of the OpenAI
//! provider that a bot runs on, a second sign-in with the same ChatGPT account renews it, signing
//! out keeps the account, and removing it takes its tokens. A fake OpenAI sign-in server and the
//! fake model endpoint stand in for OpenAI; the keychain is the mock store.

mod support;

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use spade_chatgpt::{Accounts, Config, Flows};
use spade_testkit::{FakeSignIn, Script};
use support::{Result, Spade};

/// Sets up sign-ins against `fake`, with calls going to the fake model endpoint.
fn sign_ins(spade: &Spade, fake: &FakeSignIn) -> Result<Arc<Accounts>> {
    let config = Config {
        issuer: fake.issuer.clone(),
        client_id: fake.client_id.clone(),
        callback_port: 0,
        originator: "spade".to_owned(),
        wait: Duration::from_secs(20),
        backend: spade.fake.root.clone(),
    };
    let accounts = Arc::new(Accounts::new(
        Some(spade.keys.clone()),
        config,
        Arc::new(|| 1_000),
    )?);
    spade.engine.set_sign_ins(Flows::new(
        accounts.clone(),
        Arc::new(spade_connect::OsRandom),
    ));
    Ok(accounts)
}

fn query(url: &str, name: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| {
            u.query_pairs()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.into_owned())
        })
        .unwrap_or_default()
}

/// Runs a browser sign-in to its end, and returns the finished flow.
async fn sign_in(spade: &Spade, body: Value) -> Result<Value> {
    let (status, started) = spade.post("/v1/accounts/chatgpt", body).await?;
    assert_eq!(status, 201, "{started}");
    let url = started["flow"]["url"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let back = format!(
        "{}?code=code&state={}",
        query(&url, "redirect_uri"),
        query(&url, "state")
    );
    assert_eq!(reqwest::get(back).await?.status(), 200);
    let id = started["flow"]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    for _ in 0..200 {
        let (_, read) = spade.get(&format!("/v1/accounts/chatgpt/{id}")).await?;
        if read["flow"]["state"] != "waiting" {
            return Ok(read["flow"].clone());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Err("the sign-in never ended".into())
}

async fn account(spade: &Spade, id: &str) -> Result<Value> {
    let (_, models) = spade.get("/v1/models").await?;
    Ok(models["endpoints"]
        .as_array()
        .and_then(|e| e.iter().find(|e| e["id"] == id).cloned())
        .unwrap_or_default())
}

#[tokio::test]
async fn a_chatgpt_sign_in_becomes_an_openai_account_a_bot_runs_on() -> Result {
    let spade = Spade::start(vec![Script::reply("hello from chatgpt")], Vec::new()).await?;
    let fake = FakeSignIn::start().await?;
    sign_ins(&spade, &fake)?;

    // Not without the person having read what it may mean for OpenAI's terms.
    let (status, _) = spade
        .post("/v1/accounts/chatgpt", json!({ "method": "browser" }))
        .await?;
    assert_eq!(status, 400);

    let flow = sign_in(&spade, json!({ "method": "browser", "terms_read": true })).await?;
    assert_eq!(flow["state"], "done", "{flow}");
    let shown = &flow["endpoint"];
    assert_eq!(shown["id"], "chatgpt");
    assert_eq!(shown["provider"], "openai");
    assert_eq!(shown["auth"], "chatgpt");
    assert_eq!(shown["name"], "sam@example.com");
    assert_eq!(
        shown["account"],
        json!({ "email": "sam@example.com", "plan": "plus", "signed_in": true })
    );
    let (_, models) = spade.get("/v1/models").await?;
    assert_eq!(models["sign_in"], json!(["chatgpt"]));
    // The key account made from a preset stays as it was, its own provider's.
    let fake_key = account(&spade, "fake").await?;
    assert_eq!(fake_key["auth"], "key");
    assert_eq!(fake_key["account"], Value::Null);

    // A bot on it runs with the account's token and id.
    let (status, bot) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Writer", "model": "chatgpt/gpt-5.5" }),
        )
        .await?;
    assert_eq!(status, 201, "{bot}");
    let conversation = bot["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "hi").await?;
    spade.wait_for(&conversation, "reply_finished").await?;
    let seen = spade.fake.seen();
    let call = seen
        .iter()
        .find(|s| s.headers.iter().any(|(k, _)| k == "chatgpt-account-id"))
        .ok_or("no call carried the account")?;
    assert!(
        call.key
            .as_deref()
            .is_some_and(|k| k.starts_with("Bearer "))
    );
    assert_eq!(call.body["model"], "gpt-5.5");
    assert_eq!(
        account(&spade, "chatgpt").await?["used_by"],
        json!(["Writer"])
    );

    // Nothing the API answered carries a token.
    let everything = format!("{flow}{models}{bot}");
    assert!(!everything.contains("refresh-"), "{everything}");
    Ok(())
}

#[tokio::test]
async fn signing_in_again_renews_the_account_and_another_chatgpt_account_is_added_beside_it()
-> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let fake = FakeSignIn::start().await?;
    sign_ins(&spade, &fake)?;
    let body = json!({ "method": "browser", "terms_read": true });
    assert_eq!(
        sign_in(&spade, body.clone()).await?["endpoint"]["id"],
        "chatgpt"
    );
    assert_eq!(
        sign_in(&spade, body.clone()).await?["endpoint"]["id"],
        "chatgpt"
    );
    assert_eq!(
        spade.keys.sign_in_secret("chatgpt", "refresh")?.as_deref(),
        Some("refresh-2"),
        "the renewed sign-in's tokens replace the first's"
    );

    fake.signs_in("acct-2", "kim@example.com");
    let second = sign_in(&spade, body).await?;
    assert_eq!(second["endpoint"]["id"], "chatgpt-2");
    assert_eq!(second["endpoint"]["account"]["email"], "kim@example.com");

    // Signing a named account back in as someone else is refused, and changes nothing.
    let wrong = sign_in(
        &spade,
        json!({ "method": "browser", "terms_read": true, "account": "chatgpt" }),
    )
    .await?;
    assert_eq!(wrong["state"], "failed");
    assert!(
        wrong["error"]
            .as_str()
            .is_some_and(|e| e.contains("kim@example.com")),
        "{wrong}"
    );
    assert_eq!(
        account(&spade, "chatgpt").await?["account"]["email"],
        "sam@example.com"
    );
    Ok(())
}

#[tokio::test]
async fn signing_out_keeps_the_account_and_removing_it_takes_its_tokens() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let fake = FakeSignIn::start().await?;
    sign_ins(&spade, &fake)?;
    sign_in(&spade, json!({ "method": "browser", "terms_read": true })).await?;

    let (status, out) = spade
        .post("/v1/endpoints/chatgpt/sign-out", json!({}))
        .await?;
    assert_eq!(status, 200, "{out}");
    assert_eq!(out["endpoint"]["account"]["signed_in"], false);
    assert_eq!(spade.keys.sign_in_secret("chatgpt", "refresh")?, None);
    assert_eq!(
        account(&spade, "chatgpt").await?["account"]["signed_in"],
        false
    );
    // A key account has nothing to sign out of.
    let (status, _) = spade.post("/v1/endpoints/fake/sign-out", json!({})).await?;
    assert_eq!(status, 400);

    // Back in, renamed (the reference stays), then removed: the tokens go with it.
    sign_in(
        &spade,
        json!({ "method": "browser", "terms_read": true, "account": "chatgpt" }),
    )
    .await?;
    let (status, renamed) = spade
        .patch("/v1/endpoints/chatgpt", json!({ "name": "Work ChatGPT" }))
        .await?;
    assert_eq!(status, 200, "{renamed}");
    assert_eq!(renamed["endpoint"]["id"], "chatgpt");
    assert_eq!(renamed["endpoint"]["account"]["signed_in"], true);
    assert!(spade.keys.sign_in_secret("chatgpt", "refresh")?.is_some());
    assert_eq!(spade.delete("/v1/endpoints/chatgpt").await?.0, 204);
    assert_eq!(spade.keys.sign_in_secret("chatgpt", "refresh")?, None);
    assert_eq!(spade.keys.sign_in_secret("chatgpt", "access")?, None);
    Ok(())
}

#[tokio::test]
async fn a_signed_in_accounts_address_and_settings_never_change_only_its_name() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let fake = FakeSignIn::start().await?;
    sign_ins(&spade, &fake)?;
    sign_in(&spade, json!({ "method": "browser", "terms_read": true })).await?;
    for change in [
        json!({ "base_url": "https://collector.example/v1/" }),
        json!({ "base_url": "https://collector.example/v1/", "headers": {} }),
        json!({ "headers": { "x-team": "blue" } }),
        json!({ "format": "openai-chat" }),
        json!({ "needs_key": true }),
        json!({ "name": "Work", "base_url": "https://collector.example/v1/" }),
    ] {
        let (status, body) = spade.patch("/v1/endpoints/chatgpt", change.clone()).await?;
        assert_eq!(status, 400, "{change}: {body}");
    }
    let shown = account(&spade, "chatgpt").await?;
    assert_eq!(shown["base_url"], spade.fake.root.as_str());
    assert_eq!(shown["name"], "sam@example.com");
    let (status, _) = spade
        .patch("/v1/endpoints/chatgpt", json!({ "name": "Work" }))
        .await?;
    assert_eq!(status, 200);
    Ok(())
}

#[tokio::test]
async fn removing_an_account_while_its_token_refreshes_leaves_no_token_behind() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let fake = FakeSignIn::start().await?;
    let accounts = sign_ins(&spade, &fake)?;
    // Its access token ends within five minutes of the clock: the next use refreshes it.
    fake.expires_at(1_100);
    sign_in(&spade, json!({ "method": "browser", "terms_read": true })).await?;
    fake.hold_refreshes(Duration::from_millis(600));
    let before = fake.refreshes().len();
    let refreshing = {
        let accounts = accounts.clone();
        tokio::spawn(async move { accounts.bearer("chatgpt").await })
    };
    tokio::time::sleep(Duration::from_millis(150)).await;
    let (status, body) = spade.delete("/v1/endpoints/chatgpt").await?;
    assert_eq!(status, 204, "{body}");
    let _ = refreshing.await?;
    assert_eq!(
        fake.refreshes().len(),
        before + 1,
        "the refresh was under way"
    );
    assert_eq!(spade.keys.sign_in_secret("chatgpt", "refresh")?, None);
    assert_eq!(spade.keys.sign_in_secret("chatgpt", "access")?, None);
    assert!(
        matches!(
            accounts.bearer("chatgpt").await,
            Err(spade_chatgpt::BearerError::SignedOut(_))
        ),
        "nothing is left in memory either"
    );
    Ok(())
}

#[tokio::test]
async fn a_removed_accounts_token_is_not_left_in_memory() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let fake = FakeSignIn::start().await?;
    let accounts = sign_ins(&spade, &fake)?;
    sign_in(&spade, json!({ "method": "browser", "terms_read": true })).await?;
    accounts.bearer("chatgpt").await?;
    assert_eq!(spade.delete("/v1/endpoints/chatgpt").await?.0, 204);
    assert!(matches!(
        accounts.bearer("chatgpt").await,
        Err(spade_chatgpt::BearerError::SignedOut(_))
    ));
    Ok(())
}

#[tokio::test]
async fn without_the_persons_stamp_no_sign_in_starts_and_no_signed_in_account_goes() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let fake = FakeSignIn::start().await?;
    sign_ins(&spade, &fake)?;
    sign_in(&spade, json!({ "method": "browser", "terms_read": true })).await?;

    // What any other holder of Spade's token sends: no stamp of the person's.
    let start = json!({ "method": "device", "terms_read": true });
    let (status, _) = spade.post_unstamped("/v1/accounts/chatgpt", start).await?;
    assert_eq!(status, 403);
    assert_eq!(fake.polls(), 0, "no sign-in was started");
    let (status, _) = spade
        .post_unstamped("/v1/endpoints/chatgpt/sign-out", json!({}))
        .await?;
    assert_eq!(status, 403);
    assert_eq!(
        spade.delete_unstamped("/v1/endpoints/chatgpt").await?.0,
        403
    );
    let still = account(&spade, "chatgpt").await?;
    assert_eq!(still["account"]["signed_in"], true);
    assert!(spade.keys.sign_in_secret("chatgpt", "refresh")?.is_some());

    // A key account is still the window's to remove.
    let (status, _) = spade
        .post(
            "/v1/endpoints",
            json!({ "name": "Spare", "format": "openai-chat", "base_url": "https://spare.example/v1" }),
        )
        .await?;
    assert_eq!(status, 201);
    assert_eq!(spade.delete_unstamped("/v1/endpoints/spare").await?.0, 204);
    Ok(())
}
