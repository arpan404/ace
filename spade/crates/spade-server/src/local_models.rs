//! Models that run on this computer: Ollama and LM Studio, at their default local ports. Spade
//! looks whether each is running and which models it has, so the person can pick one without
//! typing an address. Both speak OpenAI Chat Completions under `/v1` and need no key. What a
//! server answers is parsed leniently: anything that isn't a model list reads as not running.

use std::time::Duration;

use serde_json::Value;

/// A kind of local model server Spade knows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalServer {
    /// `ollama` or `lmstudio`.
    pub id: String,
    pub name: String,
    /// Its OpenAI-compatible base, ending in `/`.
    pub base_url: String,
}

/// Ollama and LM Studio at their default ports on this computer.
pub fn defaults() -> Vec<LocalServer> {
    vec![
        LocalServer {
            id: "ollama".to_owned(),
            name: "Ollama".to_owned(),
            base_url: "http://127.0.0.1:11434/v1/".to_owned(),
        },
        LocalServer {
            id: "lmstudio".to_owned(),
            name: "LM Studio".to_owned(),
            base_url: "http://127.0.0.1:1234/v1/".to_owned(),
        },
    ]
}

/// How long a look at one server may take: a local server answers at once or isn't there.
pub const PROBE: Duration = Duration::from_millis(1500);

/// The model ids in an OpenAI `GET /models` answer (`{"data": [{"id"}]}`), or Ollama's own
/// `GET /api/tags` (`{"models": [{"name"}]}`), sorted. `None` when it is neither.
pub fn model_ids(body: &Value) -> Option<Vec<String>> {
    let (list, field) = if let Some(data) = body.get("data").and_then(Value::as_array) {
        (data, "id")
    } else {
        (body.get("models").and_then(Value::as_array)?, "name")
    };
    let mut ids: Vec<String> = list
        .iter()
        .filter_map(|model| model.get(field).and_then(Value::as_str))
        .map(str::trim)
        .filter(|id| !id.is_empty() && id.len() <= 300 && !id.chars().any(char::is_control))
        .map(str::to_owned)
        .collect();
    ids.sort();
    ids.dedup();
    Some(ids)
}

/// Whether `base` answers as a model server, and its models. Reached directly, never through
/// a proxy: it is on this computer.
pub async fn probe(client: &reqwest::Client, base: &str) -> Option<Vec<String>> {
    let url = format!("{}models", base);
    let response = client.get(url).timeout(PROBE).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = response.json().await.ok()?;
    model_ids(&body)
}

/// A client for looking at local servers.
pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(PROBE)
        .build()
        .unwrap_or_default()
}

/// The same address, for matching an endpoint the person already added: scheme and host
/// lower-cased, `localhost` read as `127.0.0.1`, one trailing `/`.
pub fn same_base(a: &str, b: &str) -> bool {
    let tidy = |url: &str| {
        let url = url
            .trim()
            .to_ascii_lowercase()
            .replace("://localhost", "://127.0.0.1");
        format!("{}/", url.trim_end_matches('/'))
    };
    tidy(a) == tidy(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_openai_list_and_ollamas_own_list_both_read_as_models() {
        let openai = json!({"object": "list", "data": [{"id": "qwen3:8b"}, {"id": "llama4"}]});
        assert_eq!(
            model_ids(&openai),
            Some(vec!["llama4".to_owned(), "qwen3:8b".to_owned()])
        );
        let tags = json!({"models": [{"name": "gemma3:4b", "size": 1}]});
        assert_eq!(model_ids(&tags), Some(vec!["gemma3:4b".to_owned()]));
        assert_eq!(model_ids(&json!({"error": "nope"})), None);
        assert_eq!(model_ids(&json!({"data": []})), Some(Vec::new()));
    }

    #[test]
    fn localhost_and_its_address_are_the_same_server() {
        assert!(same_base(
            "http://localhost:11434/v1",
            "http://127.0.0.1:11434/v1/"
        ));
        assert!(!same_base(
            "http://127.0.0.1:1234/v1/",
            "http://127.0.0.1:11434/v1/"
        ));
    }
}
