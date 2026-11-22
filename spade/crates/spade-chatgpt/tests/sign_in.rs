//! Signing in to ChatGPT against a local fake of OpenAI's sign-in server, with `keyring-core`'s
//! mock store: no real keychain and no real OpenAI login is ever touched.

use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use spade_chatgpt::{Accounts, BearerError, Config, Finish, Flows, Method, SignedIn};
use spade_connect::oauth::pkce::Random;
use spade_keys::{KeyStore, SERVICE};
use spade_testkit::FakeSignIn;

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

struct Setup {
    fake: FakeSignIn,
    flows: Arc<Flows>,
    keys: KeyStore,
    now: Arc<AtomicI64>,
}

/// Counts up, so every random value differs.
struct Counter(AtomicUsize);

impl Random for Counter {
    fn fill(&self, buf: &mut [u8]) -> std::result::Result<(), String> {
        let n = self.0.fetch_add(1, Ordering::SeqCst);
        for (i, byte) in buf.iter_mut().enumerate() {
            *byte = u8::try_from((n + i) % 251).unwrap_or(0);
        }
        Ok(())
    }
}

async fn setup() -> Result<Setup> {
    let fake = FakeSignIn::start().await?;
    let keys = KeyStore::with_store(keyring_core::mock::Store::new()?, SERVICE);
    let now = Arc::new(AtomicI64::new(1_000));
    let clock_now = now.clone();
    let config = Config {
        issuer: fake.issuer.clone(),
        client_id: fake.client_id.clone(),
        callback_port: 0,
        originator: "spade".to_owned(),
        wait: Duration::from_secs(20),
        backend: "http://127.0.0.1:9/".to_owned(),
    };
    let accounts = Arc::new(Accounts::new(
        Some(keys.clone()),
        config,
        Arc::new(move || clock_now.load(Ordering::SeqCst)),
    )?);
    let flows = Flows::new(accounts, Arc::new(Counter(AtomicUsize::new(1))));
    Ok(Setup {
        fake,
        flows,
        keys,
        now,
    })
}

/// Keeps each finished sign-in's tokens as account `chatgpt`, and remembers who it was.
fn keeper(flows: &Arc<Flows>, seen: Arc<Mutex<Vec<spade_chatgpt::Account>>>) -> Finish {
    let accounts = flows.accounts().clone();
    Arc::new(move |done: SignedIn| {
        let accounts = accounts.clone();
        let seen = seen.clone();
        Box::pin(async move {
            accounts
                .keep("chatgpt", &done.tokens)
                .await
                .map_err(|e| e.to_string())?;
            seen.lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(done.account);
            Ok("chatgpt".to_owned())
        })
    })
}

async fn until_ended(flows: &Flows, id: &str) -> Result<spade_chatgpt::FlowView> {
    for _ in 0..200 {
        let view = flows.view(id).ok_or("the sign-in is gone")?;
        if view.state != "waiting" {
            return Ok(view);
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Err("the sign-in never ended".into())
}

fn query(url: &str, name: &str) -> Option<String> {
    url::Url::parse(url)
        .ok()?
        .query_pairs()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
}

#[tokio::test]
async fn a_browser_sign_in_comes_back_to_the_loopback_and_keeps_its_tokens_in_the_keychain()
-> Result {
    let s = setup().await?;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let flow = s
        .flows
        .start(Method::Browser, keeper(&s.flows, seen.clone()))
        .await?;
    let url = flow.url.clone().ok_or("no sign-in address")?;
    assert_eq!(query(&url, "client_id").as_deref(), Some("client-1"));
    assert_eq!(
        query(&url, "code_challenge_method").as_deref(),
        Some("S256")
    );
    assert_eq!(query(&url, "originator").as_deref(), Some("spade"));
    let redirect = query(&url, "redirect_uri").ok_or("no redirect")?;
    assert!(redirect.starts_with("http://127.0.0.1:"), "{redirect}");
    let state = query(&url, "state").ok_or("no state")?;

    let http = reqwest::Client::new();
    // A code with another state is turned away, and the sign-in keeps waiting for its own.
    let stray = http
        .get(format!("{redirect}?code=stolen&state=other"))
        .send()
        .await?;
    assert_eq!(stray.status(), 400);
    assert_eq!(s.flows.view(&flow.id).map(|v| v.state), Some("waiting"));
    let back = http
        .get(format!("{redirect}?code=code-1&state={state}"))
        .send()
        .await?;
    assert_eq!(back.status(), 200);

    let ended = until_ended(&s.flows, &flow.id).await?;
    assert_eq!(ended.state, "done", "{:?}", ended.error);
    assert_eq!(ended.endpoint.as_deref(), Some("chatgpt"));
    let traded = s.fake.traded();
    assert_eq!(traded.len(), 1);
    assert_eq!(traded[0].0, "code-1");
    assert_eq!(
        spade_connect::oauth::pkce::challenge(&traded[0].1),
        query(&url, "code_challenge").unwrap_or_default(),
        "the verifier traded is the one the challenge was made from"
    );
    let who = seen.lock().unwrap_or_else(|p| p.into_inner()).clone();
    assert_eq!(who[0].email.as_deref(), Some("sam@example.com"));
    assert_eq!(who[0].plan.as_deref(), Some("plus"));
    assert_eq!(
        s.keys.sign_in_secret("chatgpt", "refresh")?.as_deref(),
        Some("refresh-1")
    );
    // The view never carries a token.
    let shown = serde_json::to_string(&ended)?;
    assert!(
        !shown.contains("refresh-1") && !shown.contains("code-1"),
        "{shown}"
    );
    Ok(())
}

#[tokio::test]
async fn a_device_sign_in_shows_a_code_and_finishes_once_the_person_approves() -> Result {
    let s = setup().await?;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let flow = s
        .flows
        .start(Method::Device, keeper(&s.flows, seen))
        .await?;
    assert_eq!(flow.user_code.as_deref(), Some("ABCD-1234"));
    assert!(
        flow.url
            .as_deref()
            .is_some_and(|u| u.ends_with("/codex/device"))
    );
    let ended = until_ended(&s.flows, &flow.id).await?;
    assert_eq!(ended.state, "done", "{:?}", ended.error);
    assert!(s.fake.polls() >= 2, "it waited past a pending poll");
    let traded = s.fake.traded();
    assert_eq!(
        traded,
        vec![("device-code".to_owned(), "device-verifier".to_owned())]
    );
    Ok(())
}

#[tokio::test]
async fn a_cancelled_sign_in_ends_and_frees_its_port_for_the_next() -> Result {
    let s = setup().await?;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let first = s
        .flows
        .start(Method::Browser, keeper(&s.flows, seen.clone()))
        .await?;
    assert!(s.flows.cancel(&first.id));
    assert_eq!(s.flows.view(&first.id).map(|v| v.state), Some("cancelled"));
    assert!(!s.flows.cancel(&first.id), "only a waiting sign-in cancels");
    // Starting another cancels a waiting one.
    let second = s
        .flows
        .start(Method::Browser, keeper(&s.flows, seen.clone()))
        .await?;
    let third = s
        .flows
        .start(Method::Device, keeper(&s.flows, seen))
        .await?;
    assert_eq!(s.flows.view(&second.id).map(|v| v.state), Some("cancelled"));
    assert_eq!(s.flows.view(&third.id).map(|v| v.state), Some("waiting"));
    Ok(())
}

fn signed(fake: &FakeSignIn) -> spade_chatgpt::Tokens {
    serde_json::from_value(fake.tokens(0)).unwrap_or_else(|_| unreachable!())
}

#[tokio::test]
async fn an_access_token_near_its_end_is_refreshed_once_and_the_new_tokens_are_kept() -> Result {
    let s = setup().await?;
    let accounts = s.flows.accounts().clone();
    accounts.keep("chatgpt", &signed(&s.fake)).await?;
    // Well before its end: no refresh.
    let first = accounts.bearer("chatgpt").await?;
    assert!(s.fake.refreshes().is_empty());
    // Four minutes left: refreshed, and both calls at once share one refresh.
    s.now.store(10_000 - 240, Ordering::SeqCst);
    s.fake.expires_at(20_000);
    let (a, b) = tokio::join!(accounts.bearer("chatgpt"), accounts.bearer("chatgpt"));
    let (a, b) = (a?, b?);
    assert_eq!(a, b);
    assert_ne!(a, first);
    assert_eq!(s.fake.refreshes(), vec!["refresh-0".to_owned()]);
    assert_eq!(
        s.keys.sign_in_secret("chatgpt", "refresh")?.as_deref(),
        Some("refresh-101"),
        "a rotated refresh token is kept"
    );
    assert_eq!(s.keys.sign_in_secret("chatgpt", "access")?, Some(a));
    Ok(())
}

#[tokio::test]
async fn a_refused_refresh_signs_the_account_out_and_its_tokens_go() -> Result {
    let s = setup().await?;
    let accounts = s.flows.accounts().clone();
    accounts.keep("chatgpt", &signed(&s.fake)).await?;
    s.fake.kill("refresh-0");
    s.now.store(10_000, Ordering::SeqCst);
    let error = accounts.bearer("chatgpt").await.err().ok_or("no error")?;
    assert!(matches!(error, BearerError::SignedOut(_)), "{error:?}");
    assert_eq!(s.keys.sign_in_secret("chatgpt", "refresh")?, None);
    assert_eq!(s.keys.sign_in_secret("chatgpt", "access")?, None);
    // Signed out stays signed out, with no call to the server.
    let again = accounts.bearer("chatgpt").await.err().ok_or("no error")?;
    assert!(matches!(again, BearerError::SignedOut(_)));
    Ok(())
}

#[tokio::test]
async fn signing_out_forgets_the_tokens_and_another_account_keeps_its_own() -> Result {
    let s = setup().await?;
    let accounts = s.flows.accounts().clone();
    accounts.keep("chatgpt", &signed(&s.fake)).await?;
    accounts.keep("chatgpt-2", &signed(&s.fake)).await?;
    assert!(accounts.forget("chatgpt").await?);
    assert!(matches!(
        accounts.bearer("chatgpt").await,
        Err(BearerError::SignedOut(_))
    ));
    assert!(accounts.bearer("chatgpt-2").await.is_ok());
    Ok(())
}

#[tokio::test]
async fn two_sign_ins_started_at_once_leave_exactly_one_waiting() -> Result {
    let s = setup().await?;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (a, b) = tokio::join!(
        s.flows
            .start(Method::Device, keeper(&s.flows, seen.clone())),
        s.flows
            .start(Method::Device, keeper(&s.flows, seen.clone())),
    );
    let states = [
        s.flows.view(&a?.id).map(|v| v.state),
        s.flows.view(&b?.id).map(|v| v.state),
    ];
    let waiting = states.iter().filter(|s| **s == Some("waiting")).count();
    assert_eq!(waiting, 1, "{states:?}");
    Ok(())
}

#[tokio::test]
async fn a_sign_in_being_kept_cannot_be_cancelled_and_is_kept() -> Result {
    let s = setup().await?;
    let kept = Arc::new(AtomicUsize::new(0));
    let count = kept.clone();
    let slow: Finish = Arc::new(move |_done: SignedIn| {
        let count = count.clone();
        Box::pin(async move {
            tokio::time::sleep(Duration::from_millis(400)).await;
            count.fetch_add(1, Ordering::SeqCst);
            Ok("chatgpt".to_owned())
        })
    });
    let flow = s.flows.start(Method::Browser, slow).await?;
    let url = flow.url.clone().ok_or("no sign-in address")?;
    let back = format!(
        "{}?code=c&state={}",
        query(&url, "redirect_uri").unwrap_or_default(),
        query(&url, "state").unwrap_or_default()
    );
    assert_eq!(reqwest::get(back).await?.status(), 200);
    // Wait until the code is traded: the account is being kept now.
    for _ in 0..100 {
        if !s.fake.traded().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !s.flows.cancel(&flow.id),
        "a sign-in being kept can't be cancelled"
    );
    let ended = until_ended(&s.flows, &flow.id).await?;
    assert_eq!(ended.state, "done");
    assert_eq!(kept.load(Ordering::SeqCst), 1);
    assert_eq!(
        (ended.url, ended.user_code),
        (None, None),
        "the link goes once it ends"
    );
    Ok(())
}

#[tokio::test]
async fn a_device_sign_in_told_to_slow_down_keeps_waiting_and_finishes() -> Result {
    let s = setup().await?;
    s.fake.slow_down_once();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let flow = s
        .flows
        .start(Method::Device, keeper(&s.flows, seen))
        .await?;
    let ended = until_ended_within(&s.flows, &flow.id, Duration::from_secs(15)).await?;
    assert_eq!(ended.state, "done", "{:?}", ended.error);
    assert_eq!(ended.user_code, None, "the code goes once it ends");
    Ok(())
}

#[tokio::test]
async fn a_device_code_ends_when_the_server_says_it_does() -> Result {
    let s = setup().await?;
    s.fake.device_never_approved(2);
    let seen = Arc::new(Mutex::new(Vec::new()));
    let started = std::time::Instant::now();
    let flow = s
        .flows
        .start(Method::Device, keeper(&s.flows, seen))
        .await?;
    let ended = until_ended_within(&s.flows, &flow.id, Duration::from_secs(10)).await?;
    assert_eq!(ended.state, "failed");
    assert!(
        ended
            .error
            .as_deref()
            .is_some_and(|e| e.contains("expired")),
        "{:?}",
        ended.error
    );
    assert!(started.elapsed() < Duration::from_secs(6));
    Ok(())
}

#[tokio::test]
async fn a_stalled_connection_never_holds_up_the_real_callback() -> Result {
    let s = setup().await?;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let flow = s
        .flows
        .start(Method::Browser, keeper(&s.flows, seen))
        .await?;
    let url = flow.url.clone().ok_or("no sign-in address")?;
    let redirect = query(&url, "redirect_uri").ok_or("no redirect")?;
    let address = redirect
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or_default()
        .to_owned();
    // A connection that never sends a request.
    let _stalled = tokio::net::TcpStream::connect(&address).await?;
    tokio::time::sleep(Duration::from_millis(50)).await;
    let back = format!(
        "{redirect}?code=c&state={}",
        query(&url, "state").unwrap_or_default()
    );
    let answered = tokio::time::timeout(Duration::from_secs(2), reqwest::get(back)).await;
    assert!(
        answered.is_ok_and(|r| r.is_ok_and(|r| r.status() == 200)),
        "the callback waited on the stalled connection"
    );
    assert_eq!(until_ended(&s.flows, &flow.id).await?.state, "done");
    Ok(())
}

#[tokio::test]
async fn a_rejected_token_is_refreshed_once_however_many_calls_report_it() -> Result {
    let s = setup().await?;
    let accounts = s.flows.accounts().clone();
    accounts.keep("chatgpt", &signed(&s.fake)).await?;
    let rejected = accounts.bearer("chatgpt").await?;
    let (a, b) = tokio::join!(
        accounts.bearer_after_rejection("chatgpt", &rejected),
        accounts.bearer_after_rejection("chatgpt", &rejected),
    );
    let (a, b) = (a?, b?);
    assert_eq!(a, b);
    assert_ne!(a, rejected);
    assert_eq!(s.fake.refreshes(), vec!["refresh-0".to_owned()]);
    Ok(())
}

async fn until_ended_within(
    flows: &Flows,
    id: &str,
    within: Duration,
) -> Result<spade_chatgpt::FlowView> {
    let deadline = std::time::Instant::now() + within;
    while std::time::Instant::now() < deadline {
        let view = flows.view(id).ok_or("the sign-in is gone")?;
        if view.state != "waiting" {
            return Ok(view);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err("the sign-in never ended".into())
}

#[tokio::test]
async fn a_sign_in_whose_tokens_name_different_accounts_keeps_nothing() -> Result {
    let s = setup().await?;
    s.fake.access_names("acct-other");
    let seen = Arc::new(Mutex::new(Vec::new()));
    let flow = s
        .flows
        .start(Method::Device, keeper(&s.flows, seen.clone()))
        .await?;
    let ended = until_ended_within(&s.flows, &flow.id, Duration::from_secs(10)).await?;
    assert_eq!(ended.state, "failed");
    assert!(seen.lock().unwrap_or_else(|p| p.into_inner()).is_empty());
    assert_eq!(s.keys.sign_in_secret("chatgpt", "refresh")?, None);
    Ok(())
}
