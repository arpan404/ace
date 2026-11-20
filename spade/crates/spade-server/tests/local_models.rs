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
