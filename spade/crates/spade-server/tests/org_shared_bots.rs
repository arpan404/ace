//! Shared bots on an org host (ADR 0206 §2.3–§4), through the API: a shared bot's approvers are
//! its person, every answer and change carries a member's stamp, each outward step is on the
//! host's audit log with the member who allowed it, the organization's policy only narrows and
//! takes only a newer version the backend signed, and the log's chain verifies offline.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::Method;
use serde_json::{Value, json};
use spade_core::effect::Effect;
use spade_core::tools::Risk;
use spade_server::tools::Tool;
use spade_testkit::Script;
use support::org::{self, as_member, bind, entries, export, member, offer, policy, shared_bot};
use support::sandbox::{World, output, world};
use support::{FakeTool, Result};

const TITLE: &str = r#"{"title":"Work"}"#;

fn ran(calls: &Arc<std::sync::Mutex<Vec<Value>>>) -> usize {
    calls.lock().map(|c| c.len()).unwrap_or(0)
}

async fn until_ran(calls: &Arc<std::sync::Mutex<Vec<Value>>>, n: usize) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while ran(calls) < n && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// `text` to a shared bot's conversation, as `who`.
async fn say_as(
    w: &World,
    who: &spade_core::org::Member,
    conversation: &str,
    text: &str,
) -> Result<u16> {
    let (status, _) = as_member(
        &w.spade,
        &w.person_key,
        Some(who),
        Method::POST,
        &format!("/v1/conversations/{conversation}/messages"),
        &json!({ "text": text }),
    )
    .await?;
    Ok(status)
}

async fn answer_as(
    w: &World,
    who: Option<&spade_core::org::Member>,
    conversation: &str,
    call: &str,
) -> Result<u16> {
    let (status, _) = as_member(
        &w.spade,
        &w.person_key,
        who,
        Method::POST,
        &format!("/v1/conversations/{conversation}/approvals/{call}"),
        &json!({ "allowed": true }),
    )
    .await?;
    Ok(status)
}

#[tokio::test]
async fn a_shared_bots_send_waits_for_an_approver_and_runs_only_on_a_stamped_answer() -> Result {
    let send = FakeTool::new("crm_note", Risk::Write, "sent").declares(Effect::SendAsPerson);
    let calls = send.calls();
    let w = world(false, vec![Arc::new(send) as Arc<dyn Tool>], |_| {
        vec![
            Script::reply("").call("k1", "crm_note", json!({ "to": "lead@example.com" })),
            Script::reply("Sent."),
            Script::reply("").plain(TITLE),
        ]
    })
    .await?;
    bind(&w.spade, &w.person_key).await?;
    let maker = member("user_maker", "member");
    let (_, conversation) = shared_bot(&w.spade, &w.person_key, &maker, "CI watcher").await?;

    // Nobody talks to a shared bot without a member's stamp.
    let (status, _) = w
        .spade
        .post(
            &format!("/v1/conversations/{conversation}/messages"),
            json!({ "text": "Note the lead" }),
        )
        .await?;
    assert_eq!(status, 403);
    assert_eq!(
        say_as(&w, &maker, &conversation, "Note the lead").await?,
        202
    );
    w.spade
        .wait_for(&conversation, "approval_requested")
        .await?;

    // A member who isn't its approver, an admin who isn't named, no stamp, the person's stamp:
    // none answers it.
    let bob = member("user_bob", "member");
    let admin = member("user_root", "admin");
    assert_eq!(answer_as(&w, Some(&bob), &conversation, "k1").await?, 403);
    assert_eq!(answer_as(&w, Some(&admin), &conversation, "k1").await?, 403);
    assert_eq!(answer_as(&w, None, &conversation, "k1").await?, 403);
    let person = w.stamp("k1", "allow");
    let (status, _) = w
        .spade
        .post(
            &format!("/v1/conversations/{conversation}/approvals/k1"),
            json!({ "allowed": true }),
        )
        .await?;
    assert_eq!(status, 403, "{person}");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(ran(&calls), 0, "nothing ran before an approver answered");

    // Its approver's answer runs it, and is recorded with who gave it.
    assert_eq!(answer_as(&w, Some(&maker), &conversation, "k1").await?, 202);
    until_ran(&calls, 1).await;
    assert_eq!(ran(&calls), 1);
    let events = w.spade.wait_for(&conversation, "tool_finished").await?;
    let answered = events
        .iter()
        .find(|e| e["type"] == "approval_answered")
        .ok_or("no answer")?;
    assert_eq!(answered["by"]["account"], "user_maker");
    assert_eq!(answered["by"]["role"], "member");

    let log = export(&w.spade).await?;
    let effect = entries(&log, "bot.effect");
    assert_eq!(effect.len(), 1, "{log}");
    assert_eq!(effect[0]["metadata"]["effect"], "send_as_person");
    assert_eq!(effect[0]["metadata"]["allowed_by"], "answer:k1");
    assert_eq!(effect[0]["metadata"]["allowed_by_account"], "user_maker");
    assert!(effect[0]["metadata"]["args_sha256"].is_string());
    // Digests and names, never the arguments themselves.
    assert!(!log.contains("Note the lead"));
    let answer = entries(&log, "bot.approval.answered");
    assert_eq!(answer.len(), 1);
    assert_eq!(answer[0]["actor"]["id"], "user_maker");
    assert_eq!(entries(&log, "bot.created")[0]["actor"]["id"], "user_maker");
    Ok(())
}

#[tokio::test]
async fn a_members_grant_lets_a_shared_bot_act_and_its_entry_names_who_made_it() -> Result {
    let update = FakeTool::new("crm_update", Risk::Write, "updated").declares(Effect::Network);
    let calls = update.calls();
    let w = world(false, vec![Arc::new(update) as Arc<dyn Tool>], |_| {
        vec![
            Script::reply("").call("k1", "crm_update", json!({ "id": 7 })),
            Script::reply("Updated."),
            Script::reply("").plain(TITLE),
        ]
    })
    .await?;
    bind(&w.spade, &w.person_key).await?;
    let maker = member("user_maker", "member");
    let (bot, conversation) = shared_bot(&w.spade, &w.person_key, &maker, "CRM").await?;
    let grant = json!({ "kind": "tool", "tool": "crm_update" });
    let path = format!("/v1/agents/{bot}/grants");
    // A grant takes a member who configures the bot.
    let (status, _) = w.spade.post(&path, grant.clone()).await?;
    assert_eq!(status, 403);
    let bob = member("user_bob", "member");
    let (status, _) = as_member(
        &w.spade,
        &w.person_key,
        Some(&bob),
        Method::POST,
        &path,
        &grant,
    )
    .await?;
    assert_eq!(status, 403);
    let (status, made) = as_member(
        &w.spade,
        &w.person_key,
        Some(&maker),
        Method::POST,
        &path,
        &grant,
    )
    .await?;
    assert_eq!(status, 201, "{made}");
    assert_eq!(made["grant"]["by"], "member:user_maker");
    let grant_id = made["grant"]["id"].as_str().unwrap_or_default().to_owned();

    assert_eq!(say_as(&w, &maker, &conversation, "Update it").await?, 202);
    until_ran(&calls, 1).await;
    assert_eq!(ran(&calls), 1, "the grant covers it: nobody is asked");
    w.spade.wait_for(&conversation, "tool_finished").await?;
    let log = export(&w.spade).await?;
    let effect = entries(&log, "bot.effect");
    assert_eq!(effect.len(), 1, "{log}");
    assert_eq!(
        effect[0]["metadata"]["allowed_by"],
        format!("grant:{grant_id}")
    );
    assert_eq!(effect[0]["metadata"]["allowed_by_account"], "user_maker");
    Ok(())
}

#[tokio::test]
async fn the_org_ceiling_refuses_what_policy_forbids_even_in_full_access() -> Result {
    let pay = FakeTool::new("shop_buy", Risk::Write, "bought").declares(Effect::Pay);
    let calls = pay.calls();
    let w = world(false, vec![Arc::new(pay) as Arc<dyn Tool>], |_| {
        vec![
            Script::reply("").call("k1", "shop_buy", json!({ "item": "gpu" })),
            Script::reply("Couldn't."),
            Script::reply("").plain(TITLE),
        ]
    })
    .await?;
    bind(&w.spade, &w.person_key).await?;
    let (status, applied) = offer(
        &w.spade,
        &policy(1, r#"{"effects": {"pay": "off"}, "full_access": "admins"}"#),
    )
    .await?;
    assert_eq!(status, 200, "{applied}");
    let admin = member("user_root", "admin");
    let (bot, conversation) = shared_bot(&w.spade, &w.person_key, &admin, "Buyer").await?;
    let autonomy = format!("/v1/agents/{bot}/security/autonomy");
    let full = json!({ "autonomy": "full_access" });
    // A member who configures it can't raise it: the policy keeps that for admins.
    let configurer = member("user_cfg", "member");
    let (status, _) = as_member(
        &w.spade,
        &w.person_key,
        Some(&admin),
        Method::PUT,
        &format!("/v1/agents/{bot}/access"),
        &json!({ "approvers": ["user_root"], "configurers": ["user_cfg"] }),
    )
    .await?;
    assert_eq!(status, 200);
    let (status, _) = as_member(
        &w.spade,
        &w.person_key,
        Some(&configurer),
        Method::PUT,
        &autonomy,
        &full,
    )
    .await?;
    assert_eq!(status, 403);
    // Nor does the person's stamp count for a shared bot.
    let person = w.stamp(&bot, "full_access");
    let (status, _) = w
        .spade
        .put_with(
            &autonomy,
            full.clone(),
            &[(spade_server::security::attest::HEADER, &person)],
        )
        .await?;
    assert_eq!(status, 403);
    let (status, view) = as_member(
        &w.spade,
        &w.person_key,
        Some(&admin),
        Method::PUT,
        &autonomy,
        &full,
    )
    .await?;
    assert_eq!(status, 200, "{view}");
    assert_eq!(view["autonomy"], "full_access");

    assert_eq!(say_as(&w, &admin, &conversation, "Buy the GPU").await?, 202);
    let events = w.spade.wait_for(&conversation, "tool_finished").await?;
    assert!(
        output(&events, "k1").contains("Acme doesn't allow paying."),
        "{events:?}"
    );
    assert_eq!(ran(&calls), 0);
    Ok(())
}

#[tokio::test]
async fn a_policy_with_a_bad_signature_another_org_or_an_older_version_is_refused() -> Result {
    let w = world(false, vec![], |_| vec![]).await?;
    // Before the host belongs to an organization, no policy is taken.
    let (status, _) = offer(&w.spade, &policy(1, "{}")).await?;
    assert_eq!(status, 404);
    bind(&w.spade, &w.person_key).await?;
    let vector: Value = serde_json::from_str(include_str!("../src/org/policy-vector.json"))?;
    // The backend's own statement, as `signOrgPolicy` made it.
    let backend = json!({
        "org": vector["org"], "version": vector["version"],
        "body": vector["body"], "statement": vector["statement"],
    });
    let (status, applied) = offer(&w.spade, &backend).await?;
    assert_eq!(status, 200, "{applied}");
    assert_eq!(applied["version"], 4);
    // The same version again, and an older one well signed: an old policy can't be replayed.
    for older in [backend.clone(), policy(3, "{}")] {
        let (status, _) = offer(&w.spade, &older).await?;
        assert_eq!(status, 409, "{older}");
    }
    // A newer one with its signature changed, its body widened after signing, or another org's.
    let mut forged = policy(5, r#"{"effects": {"pay": "off"}}"#);
    let statement = forged["statement"].as_str().unwrap_or_default().to_owned();
    forged["statement"] = json!(format!("{}AA", &statement[..statement.len() - 2]));
    let mut widened = policy(5, r#"{"effects": {"pay": "off"}}"#);
    widened["body"] = json!("{}");
    for refused in [forged, widened, org::policy_for("org_OTHER", 5, "{}")] {
        let (status, _) = offer(&w.spade, &refused).await?;
        assert_eq!(status, 409, "{refused}");
    }
    let (_, view) = w.spade.get("/v1/org").await?;
    assert_eq!(view["policy"], 4);
    Ok(())
}

#[tokio::test]
async fn the_hosts_audit_log_verifies_offline_and_a_rewrite_is_found() -> Result {
    let w = world(false, vec![], |_| vec![]).await?;
    let bound = bind(&w.spade, &w.person_key).await?;
    let key = bound["auditKey"].as_str().ok_or("no audit key")?.to_owned();
    // The daemon's own rows: a hundred of them, so a checkpoint falls due.
    let rows: Vec<Value> = (0..100)
        .map(|n| {
            json!({ "action": "org.member.joined", "occurredAt": n,
                    "actor": { "type": "jit", "id": "workos" },
                    "targets": [{ "type": "member", "id": format!("user_{n}") }] })
        })
        .collect();
    let (status, body) = w
        .spade
        .post("/v1/org/audit", json!({ "entries": rows }))
        .await?;
    assert_eq!(status, 200, "{body}");
    // Spade's own actions are Spade's to write.
    let (status, _) = w
        .spade
        .post(
            "/v1/org/audit",
            json!({ "entries": [{ "action": "bot.effect", "occurredAt": 1,
                "actor": { "type": "bot", "id": "a_1" }, "targets": [{ "type": "bot", "id": "a_1" }] }] }),
        )
        .await?;
    assert_eq!(status, 422);

    let log = export(&w.spade).await?;
    assert_eq!(entries(&log, "audit.checkpoint").len(), 1, "{log}");
    let (verified, said) = spade_server::org::export::verify(&log, &key);
    assert!(verified, "{said}");
    // An entry the checkpoint covers, changed.
    let edited = log.replacen("user_42", "user_99", 1);
    let (verified, said) = spade_server::org::export::verify(&edited, &key);
    assert!(!verified);
    assert!(said.contains("an entry was changed"), "{said}");
    // Another host's key doesn't vouch for it.
    let (verified, _) =
        spade_server::org::export::verify(&log, "7UkoxijRwsbq6QM4kFmVYSlZJzpcY_k2NsFGFKyHN9E");
    assert!(!verified);
    // `ace org audit verify` runs the binary the release ships, offline.
    let dir = tempfile::tempdir()?;
    for (text, good) in [(&log, true), (&edited, false)] {
        let file = dir.path().join("export.jsonl");
        std::fs::write(&file, text)?;
        let run = std::process::Command::new(env!("CARGO_BIN_EXE_spade"))
            .arg("--verify-org-audit")
            .arg(&file)
            .arg(&key)
            .output()?;
        assert_eq!(run.status.success(), good, "{run:?}");
    }

    // The outbox gives every entry once, in order, until the backend took them.
    let (_, outbox) = w.spade.get("/v1/org/audit/outbox?limit=500").await?;
    let sent = outbox["entries"].as_array().ok_or("no entries")?;
    assert_eq!(sent.len(), 101);
    assert!(
        sent.iter()
            .all(|e| e["hash"].as_str().is_some_and(|h| h.len() == 64))
    );
    let (status, _) = w
        .spade
        .post("/v1/org/audit/forwarded", json!({ "through": 100 }))
        .await?;
    assert_eq!(status, 200);
    let (_, outbox) = w.spade.get("/v1/org/audit/outbox").await?;
    assert_eq!(outbox["entries"].as_array().map(Vec::len), Some(1));
    Ok(())
}

#[tokio::test]
async fn a_shared_bots_outward_step_doesnt_run_when_its_entry_cant_be_written() -> Result {
    let send = FakeTool::new("crm_note", Risk::Write, "sent").declares(Effect::SendAsPerson);
    let calls = send.calls();
    let w = world(false, vec![Arc::new(send) as Arc<dyn Tool>], |_| {
        vec![
            Script::reply("").call("k1", "crm_note", json!({ "to": "lead@example.com" })),
            Script::reply("Sent."),
            Script::reply("").plain(TITLE),
        ]
    })
    .await?;
    bind(&w.spade, &w.person_key).await?;
    let maker = member("user_maker", "member");
    let (_, conversation) = shared_bot(&w.spade, &w.person_key, &maker, "CI watcher").await?;
    assert_eq!(
        say_as(&w, &maker, &conversation, "Note the lead").await?,
        202
    );
    w.spade
        .wait_for(&conversation, "approval_requested")
        .await?;
    // The log refuses the call's own entry; the answer still goes in with its own.
    let raw = spade_store::Store::connect(w.spade.database())?;
    raw.execute_batch(
        "CREATE TRIGGER full BEFORE INSERT ON org_audit
         WHEN NEW.body LIKE '{\"action\":\"bot.effect\"%'
         BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
    )?;
    assert_eq!(answer_as(&w, Some(&maker), &conversation, "k1").await?, 202);
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(
        ran(&calls),
        0,
        "a step whose entry can't be written never runs"
    );
    let events = w.spade.events(&conversation).await?;
    assert!(
        !events.iter().any(|e| e["type"] == "tool_started"),
        "its start isn't stored without its entry: {events:?}"
    );
    Ok(())
}
