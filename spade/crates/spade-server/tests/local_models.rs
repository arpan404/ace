//! Models on this computer: a running Ollama (here a fake one on a free port) is found with its
//! models, one not running reads as not running, and picking a model adds its endpoint once,
//! with no key, and saves the model.

mod support;

use axum::Router;
use axum::routing::get;
use serde_json::{Value, json};
use spade_server::local_models::LocalServer;
use spade_testkit::Script;
use support::{Result, Spade};

/// A fake Ollama answering `GET /v1/models` as Ollama's OpenAI-compatible API does.
async fn fake_ollama() -> Result<String> {
    let app = Router::new().route(
        "/v1/models",
        get(|| async {
            axum::Json(json!({
                "object": "list",
                "data": [{"id": "qwen3:8b", "object": "model"}, {"id": "gemma3:4b"}],
            }))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok(format!("http://{address}/v1/"))
}

/// A port nothing listens on.
async fn closed_port() -> Result<String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    drop(listener);
    Ok(format!("http://{address}/v1/"))
}

fn server(id: &str, name: &str, base_url: String) -> LocalServer {
    LocalServer {
        id: id.to_owned(),
        name: name.to_owned(),
        base_url,
    }
}

fn find<'a>(servers: &'a Value, id: &str) -> &'a Value {
    servers["servers"]
        .as_array()
        .and_then(|all| all.iter().find(|s| s["id"] == id))
        .unwrap_or(&Value::Null)
}

#[tokio::test]
async fn a_running_ollama_is_found_and_its_models_listed() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    spade.engine.set_local_servers(vec![
        server("ollama", "Ollama", fake_ollama().await?),
        server("lmstudio", "LM Studio", closed_port().await?),
    ]);
    let (status, found) = spade.get("/v1/endpoints/local").await?;
    assert_eq!(status, 200, "{found}");
    let ollama = find(&found, "ollama");
    assert_eq!(ollama["running"], true, "{found}");
    assert_eq!(ollama["models"], json!(["gemma3:4b", "qwen3:8b"]));
    assert_eq!(ollama["endpoint"], Value::Null, "not added yet");
    let lmstudio = find(&found, "lmstudio");
    assert_eq!(lmstudio["running"], false);
    assert_eq!(lmstudio["models"], json!([]));
    Ok(())
}

#[tokio::test]
async fn picking_a_local_model_adds_its_endpoint_once_with_no_key() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let base = fake_ollama().await?;
    spade
        .engine
        .set_local_servers(vec![server("ollama", "Ollama", base.clone())]);
    let (status, used) = spade
        .post("/v1/endpoints/local/ollama", json!({ "model": "qwen3:8b" }))
        .await?;
    assert_eq!(status, 200, "{used}");
    let endpoint = used["endpoint"]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    assert_eq!(used["value"], json!(format!("{endpoint}/qwen3:8b")));
    assert_eq!(used["endpoint"]["needs_key"], false, "{used}");

    // A second model goes on the same endpoint; the listing now names it.
    let (status, again) = spade
        .post(
            "/v1/endpoints/local/ollama",
            json!({ "model": "gemma3:4b" }),
        )
        .await?;
    assert_eq!(status, 200, "{again}");
    assert_eq!(again["endpoint"]["id"], json!(endpoint));
    let (_, models) = spade.get("/v1/models").await?;
    let added: Vec<&Value> = models["endpoints"]
        .as_array()
        .map(|all| {
            all.iter()
                .filter(|e| e["base_url"] == json!(base))
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(added.len(), 1, "{models}");
    let (_, found) = spade.get("/v1/endpoints/local").await?;
    assert_eq!(find(&found, "ollama")["endpoint"], json!(endpoint));

    let (status, _) = spade
        .post("/v1/endpoints/local/vllm", json!({ "model": "x" }))
        .await?;
    assert_eq!(status, 404, "an unknown server");
    Ok(())
}

/// Adds `model` from a local server answering with `checks` (the plain, tool and structured
/// checks, in order) and waits for its checks to end; answers its `endpoint/model` and listing.
async fn checked_local_model(spade: &Spade, checks: Vec<Script>) -> Result<(String, Value)> {
    let fake = spade_testkit::FakeProvider::start_sequence(checks).await?;
    spade.engine.set_local_servers(vec![server(
        "ollama",
        "Ollama",
        format!("{}v1/", fake.root),
    )]);
    let (status, used) = spade
        .post("/v1/endpoints/local/ollama", json!({ "model": "tiny:1b" }))
        .await?;
    assert_eq!(status, 200, "{used}");
    let value = used["value"].as_str().unwrap_or_default().to_owned();
    let (endpoint, _) = value.split_once('/').unwrap_or_default();
    let endpoint = endpoint.to_owned();
    for _ in 0..200 {
        let (_, models) = spade.get("/v1/models").await?;
        let model = models["endpoints"]
            .as_array()
            .and_then(|all| all.iter().find(|e| e["id"] == json!(endpoint)))
            .and_then(|e| e["models"].as_array())
            .and_then(|all| all.iter().find(|m| m["id"] == "tiny:1b"))
            .cloned()
            .unwrap_or(Value::Null);
        if model["probes"]["state"] == "checked" {
            // Exactly the three checks went to the server: no more, nothing else.
            assert_eq!(fake.seen().len(), 3);
            return Ok((value, model));
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    Err("the local model's checks never ended".into())
}

fn answers_json() -> Script {
    Script::reply(r#"{"city":"Paris","letters":5}"#)
}

#[tokio::test]
async fn a_local_model_that_cant_call_tools_writes_only_titles_and_summaries() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let (tiny, model) = checked_local_model(
        &spade,
        vec![
            Script::reply("Hello!"),
            Script::reply("I can't look up the weather."),
            answers_json(),
        ],
    )
    .await?;
    assert_eq!(model["probes"]["plain"], "passed", "{model}");
    assert_eq!(model["probes"]["tools"], "failed", "{model}");
    assert_eq!(model["probes"]["structured"], "passed", "{model}");
    assert_eq!(model["capabilities"], json!([]), "{model}");
    assert_eq!(
        model["probes"]["why"],
        "This model didn't call tools in Spade's check, so it can't run a bot."
    );

    // No bot runs on it, and no new bot starts on it.
    let (status, body) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Tiny", "task": "", "model": tiny }),
        )
        .await?;
    assert_eq!(status, 400, "{body}");
    assert!(body.to_string().contains("didn't call tools"), "{body}");
    let (status, _) = spade
        .put("/v1/settings", json!({ "new_bot_model": tiny }))
        .await?;
    assert_eq!(status, 400);

    // Titles and summaries may run on it; helper-level work and a bot's fallbacks may not.
    for role in ["helper", "verify", "review", "main"] {
        let (status, body) = spade
            .put("/v1/models/roles", json!({ "roles": { role: [tiny] } }))
            .await?;
        assert_eq!(status, 400, "{role}: {body}");
    }
    let (status, body) = spade
        .put(
            "/v1/models/roles",
            json!({ "roles": { "title": [tiny], "compact": [tiny] } }),
        )
        .await?;
    assert!(status < 300, "{body}");
    let (_, roles) = spade.get("/v1/models/roles").await?;
    assert_eq!(roles["routes"]["title"], json!([tiny]), "{roles}");
    assert_eq!(roles["routes"]["compact"], json!([tiny]), "{roles}");
    Ok(())
}

#[tokio::test]
async fn a_local_model_that_passes_every_check_runs_bots_and_every_role() -> Result {
    let spade = Spade::start(vec![Script::reply("unused")], Vec::new()).await?;
    let (good, model) = checked_local_model(
        &spade,
        vec![
            Script::reply("Hello!"),
            Script::reply("").call("w1", "get_weather", json!({ "city": "Lisbon" })),
            answers_json(),
        ],
    )
    .await?;
    assert_eq!(model["probes"]["tools"], "passed", "{model}");
    assert_eq!(model["probes"]["why"], Value::Null, "{model}");
    assert_eq!(model["capabilities"], json!(["tools"]), "{model}");

    let (status, body) = spade
        .post(
            "/v1/agents",
            json!({ "name": "Good", "task": "", "model": good }),
        )
        .await?;
    assert_eq!(status, 201, "{body}");
    let roles: serde_json::Map<String, Value> = ["main", "helper", "verify", "title", "compact"]
        .into_iter()
        .map(|role| (role.to_owned(), json!([good])))
        .collect();
    let (status, body) = spade
        .put("/v1/models/roles", json!({ "roles": roles }))
        .await?;
    assert!(status < 300, "{body}");

    // Checks run again on asking, and only for a model on this computer.
    let (endpoint, id) = good.split_once('/').unwrap_or_default();
    let (status, _) = spade
        .post(
            &format!("/v1/endpoints/{endpoint}/probe"),
            json!({ "id": id }),
        )
        .await?;
    assert_eq!(status, 202);
    Ok(())
}
