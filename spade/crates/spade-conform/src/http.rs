//! A runtime's HTTP API, as the Runtime and Surfaces levels drive it: a base address and the
//! bearer token the runtime gave its person.

use reqwest::Method;
use serde_json::Value;

/// What one request answered.
#[derive(Debug, Clone)]
pub struct Answer {
    pub status: u16,
    pub content_type: String,
    /// `X-Content-Type-Options`.
    pub nosniff: bool,
    pub text: String,
    /// The body as JSON; `Null` when it isn't.
    pub json: Value,
}

impl Answer {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// A refusal: the request was understood and declined (4xx).
    pub fn refused(&self) -> bool {
        (400..500).contains(&self.status)
    }

    /// What the refusal said, every text field of it.
    pub fn says(&self) -> String {
        if self.json.is_null() {
            self.text.clone()
        } else {
            self.json.to_string()
        }
    }
}

/// The runtime's API: `base` is its root (`http://127.0.0.1:7777`), paths begin at `/v1`.
pub struct Http {
    base: String,
    token: String,
    client: reqwest::Client,
}

impl Http {
    pub fn new(base: &str, token: &str) -> Self {
        Self {
            base: base.trim_end_matches('/').to_owned(),
            token: token.to_owned(),
            client: reqwest::Client::new(),
        }
    }

    pub async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Answer, String> {
        let mut request = self
            .client
            .request(method.clone(), format!("{}{path}", self.base))
            .bearer_auth(&self.token);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request
            .send()
            .await
            .map_err(|e| format!("{method} {path} didn't reach the runtime: {e}"))?;
        let status = response.status().as_u16();
        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_owned()
        };
        let content_type = header("content-type");
        let nosniff = header("x-content-type-options").eq_ignore_ascii_case("nosniff");
        let text = response
            .text()
            .await
            .map_err(|e| format!("{method} {path}: {e}"))?;
        let json = serde_json::from_str(&text).unwrap_or_default();
        Ok(Answer {
            status,
            content_type,
            nosniff,
            text,
            json,
        })
    }

    pub async fn get(&self, path: &str) -> Result<Answer, String> {
        self.send(Method::GET, path, None).await
    }

    pub async fn post(&self, path: &str, body: &Value) -> Result<Answer, String> {
        self.send(Method::POST, path, Some(body)).await
    }

    pub async fn put(&self, path: &str, body: &Value) -> Result<Answer, String> {
        self.send(Method::PUT, path, Some(body)).await
    }

    pub async fn delete(&self, path: &str) -> Result<Answer, String> {
        self.send(Method::DELETE, path, None).await
    }
}
