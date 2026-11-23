//! ChatGPT accounts through the API (ADR 0214): a sign-in becomes an account of the OpenAI
//! provider that a bot runs on, a second sign-in with the same ChatGPT account renews it, signing
//! out keeps the account, and removing it takes its tokens. A fake OpenAI sign-in server and the
//! fake model endpoint stand in for OpenAI; the keychain is the mock store.

mod support;

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use spade_chatgpt::{Accounts, Config, Flows, Vault};
use spade_testkit::{FakeSignIn, Script};
use support::{Result, Spade};

/// Sets up sign-ins against `fake`, with calls going to the fake model endpoint.
fn sign_ins(spade: &Spade, fake: &FakeSignIn) -> Result<Arc<Accounts>> {
    Ok(flows_for(spade, fake)?.accounts().clone())
}

/// The sealed sign-ins of `spade`'s home, as Spade keeps them.
fn vault_of(spade: &Spade) -> Vault {
    Vault::new(
        spade.dir.path().join("sign-ins"),
        spade.keys.clone(),
        Arc::new(spade_connect::OsRandom),
    )
}

/// The refresh token kept for `account`, read back as Spade reads it.
fn kept_refresh(spade: &Spade, account: &str) -> Result<Option<String>> {
    Ok(vault_of(spade).read(account)?.map(|(_, refresh)| refresh))
}

/// Whether anything of `account`'s sign-in is kept: its sealed file or its key.
fn holds(spade: &Spade, account: &str) -> Result<bool> {
    Ok(vault_of(spade).holds(account)?)
}

/// [`sign_ins`], answering the sign-ins themselves.
fn flows_for(spade: &Spade, fake: &FakeSignIn) -> Result<Arc<Flows>> {
    let config = Config {
        issuer: fake.issuer.clone(),
        client_id: fake.client_id.clone(),
        callback_port: 0,
        originator: "spade".to_owned(),
        wait: Duration::from_secs(20),
        backend: spade.fake.root.clone(),
    };
    let accounts = Arc::new(Accounts::new(
        Some(vault_of(spade)),
        config,
        Arc::new(|| 1_000),
    )?);
    let flows = Flows::new(accounts, Arc::new(spade_connect::OsRandom));
    spade.engine.set_sign_ins(flows.clone());
    Ok(flows)
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

/// Runs a browser sign-in to its end, and returns the account it made or renewed.
async fn signed_in(spade: &Spade) -> Result<String> {
    let flow = sign_in(spade, json!({ "method": "browser", "terms_read": true })).await?;
    Ok(flow["endpoint"]["id"]
        .as_str()
        .ok_or("the sign-in made no account")?
        .to_owned())
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
    let id = shown["id"].as_str().unwrap_or_default().to_owned();
    assert!(
        id.starts_with("chatgpt-") && id.len() > "chatgpt-".len(),
        "{id}"
    );
    assert_eq!(shown["provider"], "openai");
    assert_eq!(shown["auth"], "chatgpt");
    assert_eq!(shown["name"], "ChatGPT");
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
            json!({ "name": "Writer", "model": format!("{id}/gpt-5.5") }),
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
    assert_eq!(account(&spade, &id).await?["used_by"], json!(["Writer"]));

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
    let id = signed_in(&spade).await?;
    assert_eq!(
        signed_in(&spade).await?,
        id,
        "the same ChatGPT account renews its account"
    );
    assert_eq!(
        kept_refresh(&spade, &id)?.as_deref(),
        Some("refresh-2"),
        "the renewed sign-in's tokens replace the first's"
    );

    fake.signs_in("acct-2", "kim@example.com");
    let second = sign_in(&spade, body).await?;
    assert_ne!(second["endpoint"]["id"], id.as_str());
    assert_eq!(second["endpoint"]["name"], "ChatGPT 2");
    assert_eq!(second["endpoint"]["account"]["email"], "kim@example.com");

    // Signing a named account back in as someone else is refused, and changes nothing.
    let wrong = sign_in(
        &spade,
        json!({ "method": "browser", "terms_read": true, "account": id }),
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
        account(&spade, &id).await?["account"]["email"],
        "sam@example.com"
    );
    Ok(())
}

#[tokio::test]
async fn signing_out_keeps_the_account_and_removing_it_takes_its_tokens() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let fake = FakeSignIn::start().await?;
    sign_ins(&spade, &fake)?;
    let id = signed_in(&spade).await?;

    let (status, out) = spade
        .post(&format!("/v1/endpoints/{id}/sign-out"), json!({}))
        .await?;
    assert_eq!(status, 200, "{out}");
    assert_eq!(out["endpoint"]["account"]["signed_in"], false);
    assert!(!holds(&spade, &id)?);
    assert_eq!(account(&spade, &id).await?["account"]["signed_in"], false);
    // A key account has nothing to sign out of.
    let (status, _) = spade.post("/v1/endpoints/fake/sign-out", json!({})).await?;
    assert_eq!(status, 400);

    // Back in, renamed (the reference stays), then removed: the tokens go with it.
    sign_in(
        &spade,
        json!({ "method": "browser", "terms_read": true, "account": id }),
    )
    .await?;
    let (status, renamed) = spade
        .patch(
            &format!("/v1/endpoints/{id}"),
            json!({ "name": "Work ChatGPT" }),
        )
        .await?;
    assert_eq!(status, 200, "{renamed}");
    assert_eq!(renamed["endpoint"]["id"], id.as_str());
    assert_eq!(renamed["endpoint"]["account"]["signed_in"], true);
    assert!(holds(&spade, &id)?);
    assert_eq!(spade.delete(&format!("/v1/endpoints/{id}")).await?.0, 204);
    assert!(!holds(&spade, &id)?);
    assert!(!holds(&spade, &id)?);
    Ok(())
}

#[tokio::test]
async fn a_signed_in_accounts_address_and_settings_never_change_only_its_name() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let fake = FakeSignIn::start().await?;
    sign_ins(&spade, &fake)?;
    let id = signed_in(&spade).await?;
    for change in [
        json!({ "base_url": "https://collector.example/v1/" }),
        json!({ "base_url": "https://collector.example/v1/", "headers": {} }),
        json!({ "headers": { "x-team": "blue" } }),
        json!({ "format": "openai-chat" }),
        json!({ "needs_key": true }),
        json!({ "name": "Work", "base_url": "https://collector.example/v1/" }),
    ] {
        let (status, body) = spade
            .patch(&format!("/v1/endpoints/{id}"), change.clone())
            .await?;
        assert_eq!(status, 400, "{change}: {body}");
    }
    let shown = account(&spade, &id).await?;
    assert_eq!(shown["base_url"], spade.fake.root.as_str());
    assert_eq!(shown["name"], "ChatGPT");
    let (status, _) = spade
        .patch(&format!("/v1/endpoints/{id}"), json!({ "name": "Work" }))
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
    let id = signed_in(&spade).await?;
    fake.hold_refreshes(Duration::from_millis(600));
    let before = fake.refreshes().len();
    let refreshing = {
        let (accounts, id) = (accounts.clone(), id.clone());
        tokio::spawn(async move { accounts.bearer(&id).await })
    };
    tokio::time::sleep(Duration::from_millis(150)).await;
    let (status, body) = spade.delete(&format!("/v1/endpoints/{id}")).await?;
    assert_eq!(status, 204, "{body}");
    let _ = refreshing.await?;
    assert_eq!(
        fake.refreshes().len(),
        before + 1,
        "the refresh was under way"
    );
    assert!(!holds(&spade, &id)?);
    assert!(!holds(&spade, &id)?);
    assert!(
        matches!(
            accounts.bearer(&id).await,
            Err(spade_chatgpt::BearerError::SignedOut(..))
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
    let id = signed_in(&spade).await?;
    accounts.bearer(&id).await?;
    assert_eq!(spade.delete(&format!("/v1/endpoints/{id}")).await?.0, 204);
    assert!(matches!(
        accounts.bearer(&id).await,
        Err(spade_chatgpt::BearerError::SignedOut(..))
    ));
    Ok(())
}

#[tokio::test]
async fn without_the_persons_stamp_no_sign_in_starts_and_no_signed_in_account_goes() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let fake = FakeSignIn::start().await?;
    sign_ins(&spade, &fake)?;
    let id = signed_in(&spade).await?;

    // What any other holder of Spade's token sends: no stamp of the person's.
    let start = json!({ "method": "device", "terms_read": true });
    let (status, _) = spade.post_unstamped("/v1/accounts/chatgpt", start).await?;
    assert_eq!(status, 403);
    assert_eq!(fake.polls(), 0, "no sign-in was started");
    let (status, _) = spade
        .post_unstamped(&format!("/v1/endpoints/{id}/sign-out"), json!({}))
        .await?;
    assert_eq!(status, 403);
    assert_eq!(
        spade
            .delete_unstamped(&format!("/v1/endpoints/{id}"))
            .await?
            .0,
        403
    );
    let still = account(&spade, &id).await?;
    assert_eq!(still["account"]["signed_in"], true);
    assert!(holds(&spade, &id)?);

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

#[tokio::test]
async fn removal_is_decided_on_the_row_it_removes_so_a_signed_in_account_never_goes_unconfirmed()
-> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let fake = FakeSignIn::start().await?;
    sign_ins(&spade, &fake)?;
    let id = signed_in(&spade).await?;
    let (engine, gone) = (spade.engine.clone(), id.clone());
    let refused = tokio::task::spawn_blocking(move || {
        engine.delete_endpoint(&gone, spade_server::engine::Standing::Unconfirmed)
    })
    .await?;
    assert!(
        matches!(refused, Err(spade_server::engine::EndpointError::Forbidden)),
        "{refused:?}"
    );
    assert!(holds(&spade, &id)?);
    assert_eq!(account(&spade, &id).await?["account"]["signed_in"], true);
    Ok(())
}

#[tokio::test]
async fn another_holder_of_spades_token_sees_no_account_details_flows_or_renames() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let fake = FakeSignIn::start().await?;
    sign_ins(&spade, &fake)?;
    let id = signed_in(&spade).await?;
    let (status, started) = spade
        .post(
            "/v1/accounts/chatgpt",
            json!({ "method": "device", "terms_read": true }),
        )
        .await?;
    assert_eq!(status, 201, "{started}");
    let flow = started["flow"]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();

    // Unstamped: no email, plan or sign-in state; no link or code; no cancel; no rename.
    let (_, models) = spade.get_unstamped("/v1/models").await?;
    let shown = models["endpoints"]
        .as_array()
        .and_then(|all| all.iter().find(|e| e["id"] == id.as_str()).cloned())
        .unwrap_or_default();
    assert_eq!(shown["auth"], "chatgpt");
    assert_eq!(shown["account"], serde_json::Value::Null);
    assert!(!models.to_string().contains("sam@example.com"));
    let path = format!("/v1/accounts/chatgpt/{flow}");
    let (status, read) = spade.get_unstamped(&path).await?;
    assert_eq!(status, 403);
    assert!(!read.to_string().contains("ABCD-1234"));
    assert_eq!(spade.delete_unstamped(&path).await?.0, 403);
    let (status, _) = spade
        .patch_unstamped(
            &format!("/v1/endpoints/{id}"),
            json!({ "name": "Mine now" }),
        )
        .await?;
    assert_eq!(status, 403);

    // The person sees all of it.
    assert_eq!(
        account(&spade, &id).await?["account"]["email"],
        "sam@example.com"
    );
    let (status, read) = spade.get(&path).await?;
    assert_eq!(status, 200);
    assert_eq!(read["flow"]["user_code"], "ABCD-1234");
    assert_eq!(spade.delete(&path).await?.0, 204);
    Ok(())
}

#[tokio::test]
async fn a_stamp_holds_for_its_own_request_only() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let fake = FakeSignIn::start().await?;
    sign_ins(&spade, &fake)?;
    // Stamped over a body that had not read the terms, sent with one that says it had.
    let stamped = serde_json::to_vec(&json!({ "method": "device", "terms_read": false }))?;
    let digest = {
        use sha2::{Digest, Sha256};
        Sha256::digest(&stamped)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    };
    let stamp = spade.person_stamp("accounts", &format!("POST /v1/accounts/chatgpt:{digest}"))?;
    let (status, _) = spade
        .post_with(
            "/v1/accounts/chatgpt",
            json!({ "method": "device", "terms_read": true }),
            &[(spade_server::security::attest::HEADER, stamp.as_str())],
        )
        .await?;
    assert_eq!(status, 403);
    // A stamp for one route is not one for another.
    let empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    let stamp = spade.person_stamp("accounts", &format!("GET /v1/models:{empty}"))?;
    let (status, _) = spade
        .post_with(
            "/v1/accounts/chatgpt",
            json!({ "method": "device", "terms_read": true }),
            &[(spade_server::security::attest::HEADER, stamp.as_str())],
        )
        .await?;
    assert_eq!(status, 403);
    assert_eq!(fake.polls(), 0, "no sign-in started");
    Ok(())
}

#[tokio::test]
async fn an_account_id_once_removed_is_never_given_out_again() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let fake = FakeSignIn::start().await?;
    sign_ins(&spade, &fake)?;
    let first = signed_in(&spade).await?;
    assert_eq!(
        spade.delete(&format!("/v1/endpoints/{first}")).await?.0,
        204
    );
    // The same ChatGPT account signed in again is a new account, under a new id.
    let again = signed_in(&spade).await?;
    assert_ne!(again, first);
    // So with every endpoint: a key endpoint added again by the same name gets a new id.
    let spare =
        json!({ "name": "Spare", "format": "openai-chat", "base_url": "https://spare.example/v1" });
    let (_, made) = spade.post("/v1/endpoints", spare.clone()).await?;
    assert_eq!(made["endpoint"]["id"], "spare");
    assert_eq!(spade.delete("/v1/endpoints/spare").await?.0, 204);
    let (_, remade) = spade.post("/v1/endpoints", spare).await?;
    assert_ne!(remade["endpoint"]["id"], "spare");
    Ok(())
}

#[tokio::test]
async fn an_account_removed_between_its_tokens_and_its_commit_leaves_nothing_behind() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let fake = FakeSignIn::start().await?;
    let flows = flows_for(&spade, &fake)?;
    let other = signed_in(&spade).await?;
    // The next sign-in's account is removed right after its tokens are kept.
    let engine = spade.engine.clone();
    let removed = Arc::new(std::sync::Mutex::new(None));
    let noted = removed.clone();
    flows.set_after_keep(Arc::new(move |id: String| {
        let (engine, noted) = (engine.clone(), noted.clone());
        Box::pin(async move {
            let gone = id.clone();
            let _ = tokio::task::spawn_blocking(move || {
                engine.delete_endpoint(&gone, spade_server::engine::Standing::Person)
            })
            .await;
            *noted.lock().unwrap_or_else(|p| p.into_inner()) = Some(id);
        })
    }));
    fake.signs_in("acct-2", "kim@example.com");
    let flow = sign_in(&spade, json!({ "method": "browser", "terms_read": true })).await?;
    assert_eq!(flow["state"], "failed", "{flow}");
    let gone = removed
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .ok_or("the hook never ran")?;
    assert_ne!(gone, other);
    assert!(!holds(&spade, &gone)?);
    assert!(!holds(&spade, &gone)?);
    assert_eq!(account(&spade, &gone).await?, Value::Null);
    // Nothing takes its id again, an endpoint named after it included.
    let (status, made) = spade
        .post(
            "/v1/endpoints",
            json!({ "name": gone, "format": "openai-chat", "base_url": "https://spare.example/v1" }),
        )
        .await?;
    assert_eq!(status, 201, "{made}");
    assert_ne!(made["endpoint"]["id"], gone.as_str());
    // The account that was there before is untouched.
    assert!(holds(&spade, &other)?);
    assert_eq!(account(&spade, &other).await?["account"]["signed_in"], true);
    Ok(())
}

#[tokio::test]
async fn an_account_named_after_its_email_shows_only_the_provider_to_other_callers() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let fake = FakeSignIn::start().await?;
    sign_ins(&spade, &fake)?;
    let id = signed_in(&spade).await?;
    // As an older build named it.
    let (status, _) = spade
        .patch(
            &format!("/v1/endpoints/{id}"),
            json!({ "name": "sam@example.com" }),
        )
        .await?;
    assert_eq!(status, 200);
    let (_, models) = spade.get_unstamped("/v1/models").await?;
    assert!(!models.to_string().contains("sam@example.com"), "{models}");
    assert_eq!(account(&spade, &id).await?["name"], "sam@example.com");
    Ok(())
}

#[tokio::test]
async fn a_backend_that_never_starts_answering_cannot_hold_off_a_sign_out() -> Result {
    // The backend takes every request and says nothing for half a minute.
    let spade = Spade::start(
        vec![Script::reply("late").held(Duration::from_secs(30))],
        Vec::new(),
    )
    .await?;
    let fake = FakeSignIn::start().await?;
    sign_ins(&spade, &fake)?;
    spade
        .engine
        .models()
        .set_stream_waits(spade_models::StreamWaits {
            headers: Duration::from_millis(300),
            idle: Duration::from_secs(10),
            total: Duration::from_secs(60),
        });
    let id = signed_in(&spade).await?;
    let (_, bot) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Waiter", "model": format!("{id}/gpt-5.5") }),
        )
        .await?;
    let conversation = bot["agent"]["conversation"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    spade.say(&conversation, "hi").await?;
    // The call is on its way to the stalled backend.
    for _ in 0..200 {
        if !spade.fake.seen().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let signed_out = tokio::time::timeout(
        Duration::from_secs(10),
        spade.post(&format!("/v1/endpoints/{id}/sign-out"), json!({})),
    )
    .await
    .map_err(|_| "the sign-out waited on the stalled call")??;
    assert_eq!(signed_out.0, 200, "{}", signed_out.1);
    spade
        .wait_for_any(&conversation, &["reply_failed", "reply_finished"])
        .await?;
    let calls = spade
        .fake
        .seen()
        .iter()
        .filter(|s| s.path.ends_with("/responses"))
        .count();
    assert_eq!(
        calls, 1,
        "a stall may have been billed: it is never sent again"
    );
    Ok(())
}

#[tokio::test]
async fn a_sign_out_between_a_sign_ins_tokens_and_its_commit_wins() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let fake = FakeSignIn::start().await?;
    let flows = flows_for(&spade, &fake)?;
    let id = signed_in(&spade).await?;
    // The account is signed in again; right after the new tokens are kept, it is signed out.
    let engine = spade.engine.clone();
    flows.set_after_keep(Arc::new(move |account: String| {
        let engine = engine.clone();
        Box::pin(async move {
            let _ = engine.sign_out(&account).await;
        })
    }));
    let flow = sign_in(
        &spade,
        json!({ "method": "browser", "terms_read": true, "account": id }),
    )
    .await?;
    assert_eq!(flow["state"], "failed", "{flow}");
    assert_eq!(account(&spade, &id).await?["account"]["signed_in"], false);
    assert!(!holds(&spade, &id)?);
    Ok(())
}

/// Ids that make every new sign-in's suffix the same, and count for everything else.
struct Colliding(std::sync::atomic::AtomicU64);

impl spade_server::clock::Ids for Colliding {
    fn next(&self, prefix: &str) -> String {
        if prefix.is_empty() {
            return "_samesame".to_owned();
        }
        let n = self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        format!("{prefix}_{n}")
    }
}

#[tokio::test]
async fn a_sign_in_whose_id_was_ever_used_is_refused_rather_than_given_it_again() -> Result {
    let spade = Spade::start_with(
        vec![Script::reply("unused")],
        Vec::new(),
        support::Options {
            ids: Some(Arc::new(Colliding(std::sync::atomic::AtomicU64::new(0)))),
            ..support::Options::default()
        },
    )
    .await?;
    let fake = FakeSignIn::start().await?;
    sign_ins(&spade, &fake)?;
    let first = signed_in(&spade).await?;
    assert_eq!(first, "chatgpt-samesame");
    assert_eq!(
        spade.delete(&format!("/v1/endpoints/{first}")).await?.0,
        204
    );
    // Every id the next sign-in could take is the removed one's: it fails, and takes nothing.
    let flow = sign_in(&spade, json!({ "method": "browser", "terms_read": true })).await?;
    assert_eq!(flow["state"], "failed", "{flow}");
    assert_eq!(account(&spade, &first).await?, Value::Null);
    assert!(!holds(&spade, &first)?);
    Ok(())
}

#[tokio::test]
async fn a_refused_refreshs_late_signed_out_never_lands_on_a_newer_sign_in() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let fake = FakeSignIn::start().await?;
    let accounts = sign_ins(&spade, &fake)?;
    // Its access token is always near its end, so the next use refreshes.
    fake.expires_at(1_100);
    let id = signed_in(&spade).await?;
    let refresh = kept_refresh(&spade, &id)?.ok_or("no refresh token kept")?;
    fake.kill(&refresh);
    let refused = accounts.bearer(&id).await;
    let Err(spade_chatgpt::BearerError::SignedOut(_, generation)) = refused else {
        return Err(format!("the refresh was not refused: {refused:?}").into());
    };
    // Signed in again before the refusal's "signed out" is written.
    assert_eq!(signed_in(&spade).await?, id);
    assert_eq!(account(&spade, &id).await?["account"]["signed_in"], true);
    spade.engine.record_signed_out(&id, generation)?;
    assert_eq!(
        account(&spade, &id).await?["account"]["signed_in"],
        true,
        "a late write from the old credential signed the newer one out"
    );
    Ok(())
}

#[tokio::test]
async fn a_restored_home_without_its_sign_in_keys_shows_those_accounts_signed_out() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let fake = FakeSignIn::start().await?;
    sign_ins(&spade, &fake)?;
    let id = signed_in(&spade).await?;
    // As on another machine: the data folder came along, the keychain didn't.
    spade.keys.delete_sign_in_key(&id)?;
    let engine = spade.engine.clone();
    tokio::task::spawn_blocking(move || engine.reconcile_sign_ins()).await?;
    assert_eq!(account(&spade, &id).await?["account"]["signed_in"], false);
    Ok(())
}
