mod support;

use std::sync::Arc;

use serde_json::{Value, json};
use spade_server::tools::{EngineHandle, TemplateDraft, TemplatePrivacy};
use spade_testkit::Script;
use support::{Result, Spade, TOKEN};

struct IdentityScan;

impl TemplatePrivacy for IdentityScan {
    fn scan<'a>(
        &'a self,
        texts: &'a [&'a str],
    ) -> spade_server::teams::BoxFuture<'a, Option<bool>> {
        Box::pin(async move {
            if texts.contains(&"Identity unavailable") {
                None
            } else {
                Some(false)
            }
        })
    }
}

async fn signed(
    spade: &Spade,
    id: &str,
    operation: &str,
    body: &Value,
) -> Result<(u16, Value, String)> {
    let bytes = serde_json::to_vec(body)?;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let result = tokio::process::Command::new("bun")
            .current_dir(root)
            .args([
                "-e",
                r#"import { templatePort } from "./apps/daemon/src/marketplace/template-port.ts";
                import { publishTemplate } from "./apps/daemon/src/marketplace/publish-template.ts";
                import { MarketHttp } from "./apps/daemon/src/marketplace/http.ts";
                import { contentHash, hashFiles, readArchive, typeLimits } from "./packages/marketplace/src/index.ts";
                import { readFileSync } from "node:fs";
                const [base, token, key, id, operation, data] = process.argv.slice(1);
                const body = JSON.parse(data);
                let captured;
                let stampBody;
                const proxy = Bun.serve({
                    hostname: "127.0.0.1", port: 0,
                    async fetch(req) {
                        const headers = new Headers(req.headers);
                        headers.delete("host");
                        const payload = await req.arrayBuffer();
                        stampBody = new TextDecoder().decode(payload);
                        const reply = await fetch(base + new URL(req.url).pathname, {
                            method: req.method, body: payload, headers,
                        });
                        captured = [reply.status, await reply.clone().json(), headers.get("x-ace-person")];
                        return reply;
                    }
                });
                const port = templatePort({
                    connection: () => ({ host: "127.0.0.1", port: proxy.port, token }),
                    key: () => Buffer.from(readFileSync(key, "utf8").trim(), "hex"),
                    now: Date.now,
                });
                try {
                    if (operation === "workflow") {
                        const name = id.replaceAll("_", "-");
                        const type = "spade-bot";
                        const version = "1.0.0";
                        const publisher = "pub_example";
                        const shareId = "019adfd4-3a58-7bed-92a8-2d919dc241ab";
                        const title = "Render benchmarks";
                        let uploaded;
                        let calls = [];
                        const store = Bun.serve({
                            hostname: "127.0.0.1", port: 0,
                            async fetch(req) {
                                const path = new URL(req.url).pathname;
                                calls.push(path);
                                if (path === "/v1/me") return Response.json({
                                    profile: {id: publisher, handle: "tester", displayName: title, bio: "",
                                        links: [], joined: 1, verified: false, proofs: [], pins: []},
                                    state: "active", newPublisher: false,
                                    limits: {uploadsToday: 0, uploadsPerDay: 10, storedBytes: 0,
                                        quotaBytes: 1000000, drafts: 0, draftLimit: 20},
                                    drafts: [], transfers: [], entries: [],
                                });
                                if (path === "/v1/me/entries/" + type + "/" + name && body.hash)
                                    return Response.json({
                                        summary: {type, name, title, line: "", visibility: body.review.visibility,
                                            shareId, archived: false, pinned: false, reviewed: false,
                                            versions: 1, downloads: 0, pendingListing: false, openReports: 0},
                                        listing: {title, line: "", description: "", categories: [], keywords: [],
                                            links: [], previews: []},
                                        versions: [{version, hash: body.hash, size: 1, published: 1,
                                            status: "waiting", held: false, changelog: "", downloads: 0}],
                                    });
                                if (path === "/v1/me/drafts" && req.method === "POST") {
                                    const files = readArchive(new Uint8Array(await req.arrayBuffer()), typeLimits[type]);
                                    uploaded = contentHash(hashFiles(files));
                                    return Response.json({error: "unavailable"}, {status: 503});
                                }
                                return Response.json({error: "not_found"}, {status: 404});
                            },
                        });
                        try {
                            const http = new MarketHttp({origin: store.url.origin, fetch});
                            const result = await publishTemplate(port, {http, grant: async () => "test"}, {
                                op: "publishTemplate", id, review: body.review,
                            }, ["Ada Example", "ada@example.test"]);
                            captured = [200, {result, calls, uploaded, stampBody}, captured?.[2] ?? ""];
                        } finally {
                            store.stop(true);
                        }
                    }
                    if (operation === "skill-privacy") await port.scanSkill(body);
                    if (operation === "authorize") {
                        const draft = await port.authorize(id, body);
                        captured[1] = draft;
                    }
                    if (operation === "begin") await port.begin(id, body.review, body.draft, body.binding);
                    if (operation === "published") {
                        const { shareId, ...binding } = body;
                        await port.published(id, binding, shareId);
                    }
                } catch (error) {
                    if (!captured || captured[0] < 400) throw error;
                } finally {
                    proxy.stop(true);
                }
                console.log(JSON.stringify(captured));"#,
                &spade.base,
                TOKEN,
            ])
            .arg(&spade.person_key_path)
            .arg(id)
            .arg(operation)
            .arg(String::from_utf8(bytes)?)
            .output()
            .await?;
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    Ok(serde_json::from_slice(&result.stdout)?)
}

async fn restart(spade: Spade) -> Result<Spade> {
    let spade = spade
        .restart_with(
            vec![],
            vec![Script::reply("unused")],
            support::Options {
                ids: Some(Arc::new(spade_server::clock::SystemIds)),
                ..support::Options::default()
            },
        )
        .await?;
    support::packaged::secure(&spade).await?;
    Ok(spade)
}

#[tokio::test]
async fn template_draft_refuses_personal_data_and_bearer_cannot_publish() -> Result {
    let proposal = json!({
        "description": "Measure rendering performance.",
        "task": "Record a baseline before making changes.",
        "notes": ["Compare results under the same conditions."],
        "knowledge": [
            {"kind":"playbook","topic":"renderer/performance","title":"Profile in stages","body":"Measure startup, parsing and rendering separately."},
            {"kind":"lesson","topic":"renderer/performance","title":"Warm caches change results","body":"Report cold and warm runs separately."}
        ],
        "heartbeat": {"every_minutes":60,"checklist":"Look for benchmark regressions."},
        "routines":[{"name":"Daily check","instruction":"Compare benchmark medians.","schedule":"daily at 09:00"}],
        "surfaces":[{
            "definition":{"kind":"panel","id":"results","file":"panels/results/index.html","title":"Benchmark totals"},
            "text":"<!doctype html><title>Benchmark totals</title><h1>Results</h1>"
        }],
        "contracts":[{
            "name":"summarize","summary":"Summarize a measured baseline.",
            "input":{"type":"object","properties":{"baseline":{"type":"number"}}},
            "output":{"type":"object","properties":{"summary":{"type":"string","maxLength":300}}}
        }],
    });
    let mut private = proposal.clone();
    private["knowledge"][1]["body"] = json!("Email the result to testing@example.test.");
    let mut copied = proposal.clone();
    copied["knowledge"][0]["body"] =
        json!("Open the archived results from my private benchmark run.");
    let engine = EngineHandle::default();
    let spade = support::packaged::secured(
        vec![
            Script::reply("").call("private", "template_draft", private),
            Script::reply("").call("copied", "template_draft", copied),
            Script::reply("").call(
                "offline",
                "template_draft",
                json!({
                    "description": "Identity unavailable",
                    "task": "Measure the baseline."
                }),
            ),
            Script::reply("").call("clean", "template_draft", proposal.clone()),
            Script::reply("").call("other", "template_draft", proposal),
            Script::reply("The template is unpublished."),
        ],
        vec![Arc::new(TemplateDraft::new(
            engine.clone(),
            None,
            None,
            Some(Arc::new(IdentityScan)),
        ))],
    )
    .await?;
    engine.set(&spade.engine);
    let agent = spade
        .new_agent("Render benchmarks", "Work in /Users/test/private.")
        .await?;
    let chat = agent["conversation"].as_str().unwrap_or_default();
    let bot = agent["id"].as_str().ok_or("missing source bot")?;
    let (status, _) = spade.post(&format!("/v1/agents/{bot}/knowledge"), json!({
        "topic":"rendering","title":"Archived run","body":"Open the archived results from my private benchmark run."
    })).await?;
    assert_eq!(status, 201);
    spade.say(chat, "Draft a template.").await?;
    let events = spade.wait_for(chat, "reply_finished").await?;
    let cards: Vec<&Value> = events
        .iter()
        .filter(|event| event["type"] == "card_shown")
        .collect();
    assert_eq!(cards.len(), 2, "{events:?}");
    let other_id = cards[1]["card"].as_str().ok_or("missing second draft")?;
    let id = cards[0]["card"].as_str().unwrap_or_default();
    let (status, details) = spade.get(&format!("/v1/share-templates/{id}")).await?;
    assert_eq!(status, 200);
    assert_eq!(details["visibility"], Value::Null);
    assert_eq!(details["draft"]["recipe"]["version"], 3);
    assert!(!details["draft"]["recipe"].to_string().contains("fake/m"));
    assert_eq!(
        details["draft"]["recipe"]["model_roles"]["helper"],
        "capable"
    );
    assert_eq!(
        details["draft"]["recipe"]["task"],
        "Record a baseline before making changes."
    );
    assert_eq!(
        details["draft"]["recipe"]["notes"],
        json!(["Compare results under the same conditions."])
    );
    assert_eq!(
        details["draft"]["recipe"]["knowledge"][0]["kind"],
        "playbook"
    );
    assert_eq!(details["draft"]["recipe"]["knowledge"][1]["kind"], "lesson");
    assert_eq!(details["draft"]["recipe"]["heartbeat"]["every_minutes"], 60);
    assert_eq!(
        details["draft"]["surface_files"][0]["path"],
        "panels/results/index.html"
    );
    assert_eq!(
        details["draft"]["recipe"]["contracts"][0]["name"],
        "summarize"
    );

    let path = format!("/v1/share-templates/{id}/authorize");
    let review = json!({
        "revision": details["revision"],
        "visibility": "unlisted",
        "reviewed": true,
        "name": "Render benchmarks",
        "description": "Measure rendering performance.",
        "task": "Compare median run times.",
        "notes": [],
        "skills": [],
        "routines": [],
        "connectors": [],
        "knowledge": [details["draft"]["recipe"]["knowledge"][1].clone()],
        "surfaces": [],
        "include_heartbeat": true,
    });
    let (status, _) = spade.post_unstamped(&path, review.clone()).await?;
    assert_eq!(status, 403);

    let (status, _) = spade.post(&format!("/v1/agents/{bot}/knowledge"), json!({
        "topic":"reviews","title":"Internal status update",
        "body":"Send quarterly visualization metrics from the walnut repository to the internal dashboard."
    })).await?;
    assert_eq!(status, 201);
    let mut refused = review.clone();
    refused["knowledge"][0]["body"] =
        json!("Report quarterly visualization measurements from the walnut repository.");
    let (status, _, _) = signed(&spade, id, "authorize", &refused).await?;
    assert_eq!(status, 422);
    let (_, roster) = spade.get("/v1/agents").await?;
    let main = roster["agents"]
        .as_array()
        .and_then(|agents| agents.iter().find(|agent| agent["kind"] == "main"))
        .and_then(|agent| agent["id"].as_str())
        .ok_or("missing main agent")?;
    let (status, _) = spade.post(&format!("/v1/agents/{main}/knowledge"), json!({
        "topic": "personal",
        "title": "Private workspace",
        "body": "Review the octagon prototype budget with festival organizers before signing contracts."
    })).await?;
    assert_eq!(status, 201);
    let mut main_overlap = review.clone();
    main_overlap["task"] =
        json!("Discuss the octagon prototype budget with festival coordinators.");
    let (status, _, _) = signed(&spade, id, "authorize", &main_overlap).await?;
    assert_eq!(status, 422);
    let (status, authorized, stamp) = signed(&spade, id, "authorize", &review).await?;
    assert_eq!(status, 200, "{authorized}");
    assert_eq!(authorized["recipe"]["task"], "Compare median run times.");
    assert_eq!(authorized["recipe"]["notes"], json!([]));
    assert_eq!(
        authorized["recipe"]["knowledge"].as_array().map(Vec::len),
        Some(1)
    );
    assert_eq!(authorized["recipe"]["knowledge"][0]["kind"], "lesson");
    assert_eq!(authorized["surface_files"], json!([]));

    let replay = spade
        .http
        .post(format!("{}{path}", spade.base))
        .bearer_auth(TOKEN)
        .header(spade_server::security::attest::HEADER, stamp)
        .body(serde_json::to_vec(&review)?)
        .send()
        .await?;
    assert_eq!(replay.status().as_u16(), 403);

    let path = format!("/v1/share-templates/{id}");
    let (_, still) = spade.get(&path).await?;
    assert_eq!(
        still, details,
        "an authorization alone must leave the draft unchanged"
    );
    let mut identity_review = review.clone();
    identity_review["task"] = json!("Give Ada Example the benchmark summary.");
    let (_, refused, _) = signed(
        &spade,
        id,
        "workflow",
        &json!({ "review": identity_review }),
    )
    .await?;
    assert_eq!(refused["result"]["code"], "invalid");
    assert_eq!(refused["calls"], json!([]));
    let (_, still) = spade.get(&path).await?;
    assert_eq!(
        still, details,
        "the final identity scan must not keep edits"
    );
    let (status, _, _) = signed(
        &spade,
        "skill",
        "skill-privacy",
        &json!(["Report quarterly visualization measurements from the walnut repository."]),
    )
    .await?;
    assert_eq!(status, 422);
    let (status, _, _) = signed(
        &spade,
        "skill",
        "skill-privacy",
        &json!(["Measure the renderer in three stages."]),
    )
    .await?;
    assert_eq!(status, 200);

    let (_, staged, _) = signed(&spade, id, "workflow", &json!({ "review": review })).await?;
    assert_eq!(staged["result"]["op"], "error", "{staged}");
    let hash = staged["uploaded"]
        .as_str()
        .ok_or("missing attempted upload")?;
    let binding = json!({
        "revision": review["revision"], "visibility": "unlisted",
        "hash": hash, "publisher": "pub_example",
    });
    let mut other_review = review.clone();
    let (_, other) = spade
        .get(&format!("/v1/share-templates/{other_id}"))
        .await?;
    other_review["revision"] = other["revision"].clone();
    let mut other_binding = binding.clone();
    other_binding["revision"] = other["revision"].clone();
    let (status, other_draft, _) = signed(&spade, other_id, "authorize", &other_review).await?;
    assert_eq!(status, 200);
    let other_attempt = json!({
        "binding": other_binding, "review": other_review, "draft": other_draft
    });
    let (status, _, _) = signed(&spade, other_id, "begin", &other_attempt).await?;
    assert_eq!(status, 200);
    let spade = restart(spade).await?;
    let (_, pending) = spade.get(&path).await?;
    assert_eq!(pending["revision"], details["revision"]);
    assert_eq!(pending["visibility"], Value::Null);
    assert_eq!(pending["draft"], authorized);
    let mut receipt = binding.clone();
    receipt["shareId"] = json!("019adfd4-3a58-7bed-92a8-2d919dc241ab");
    let mut wrong = binding.clone();
    wrong["visibility"] = json!("listed");
    let (status, _, _) = signed(&spade, id, "published", &wrong).await?;
    assert_eq!(status, 409);
    let (_, mismatch, _) = signed(
        &spade,
        id,
        "workflow",
        &json!({ "review": review, "hash": "0".repeat(64) }),
    )
    .await?;
    assert_eq!(mismatch["result"]["code"], "conflict");
    let (status, recovered, receipt_stamp) = signed(
        &spade,
        id,
        "workflow",
        &json!({ "review": review, "hash": hash }),
    )
    .await?;
    assert_eq!(status, 200);
    assert_eq!(
        recovered["result"]["op"], "publishedTemplate",
        "{recovered}"
    );
    assert_eq!(recovered["calls"].as_array().map(Vec::len), Some(2));
    assert_eq!(recovered["result"]["shareId"], receipt["shareId"]);
    let spade = restart(spade).await?;
    let response = spade
        .http
        .post(format!("{}{path}/published", spade.base))
        .bearer_auth(TOKEN)
        .header(spade_server::security::attest::HEADER, receipt_stamp)
        .body(
            recovered["stampBody"]
                .as_str()
                .ok_or("missing stamped receipt body")?
                .to_owned(),
        )
        .send()
        .await?;
    assert_eq!(response.status().as_u16(), 403);
    let (status, _, _) = signed(&spade, id, "published", &receipt).await?;
    assert_eq!(status, 409);
    let (_, published) = spade.get(&path).await?;
    assert_eq!(published["visibility"], "unlisted");
    assert_eq!(published["shareId"], receipt["shareId"]);
    assert_ne!(published["revision"], details["revision"]);
    let (status, deleted) = spade.delete(&format!("/v1/agents/{bot}")).await?;
    assert!(matches!(status, 200 | 204), "{status} {deleted}");
    let (status, _, _) = signed(&spade, other_id, "published", &other_binding).await?;
    assert_eq!(status, 410);
    let (status, installed) = spade
        .post(
            "/v1/agents",
            json!({
                "recipe": authorized["recipe"],
                "from_recipe": {"source":"local","name":"benchmark-template","version":"1.0.0"},
                "start_routines": false,
            }),
        )
        .await?;
    assert_eq!(status, 201, "{installed}");
    let bot = installed["agent"]["id"]
        .as_str()
        .ok_or("missing installed bot")?;
    let (status, knowledge) = spade.get(&format!("/v1/agents/{bot}/knowledge")).await?;
    assert_eq!(status, 200);
    assert_eq!(
        knowledge["entries"][0]["title"],
        "Warm caches change results"
    );
    assert_eq!(
        knowledge["entries"][0]["body"],
        "Report cold and warm runs separately."
    );
    let (status, heartbeat) = spade.get(&format!("/v1/agents/{bot}/heartbeat")).await?;
    assert_eq!(status, 200);
    assert_eq!(heartbeat["heartbeat"]["enabled"], false);
    assert_eq!(heartbeat["heartbeat"]["every_minutes"], 60);
    Ok(())
}
