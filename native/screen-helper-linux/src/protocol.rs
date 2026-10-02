use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub type Result<T> = std::result::Result<T, Fault>;
#[derive(Debug, Serialize)]
pub struct Fault {
    pub code: &'static str,
    pub message: String,
}
impl Fault {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into().chars().take(512).collect(),
        }
    }
}
impl std::fmt::Display for Fault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for Fault {}
pub fn internal(e: impl std::fmt::Display) -> Fault {
    Fault::new("internal", e.to_string())
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub kind: String,
    pub window_id: Option<u32>,
    pub display_id: Option<u32>,
    pub bundle_id: Option<String>,
    #[serde(default)]
    pub bundle_ids: Vec<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub version: u8,
    pub id: String,
    pub op: String,
    pub session_id: Option<String>,
    pub target: Option<Target>,
    #[serde(default)]
    pub allowlist: Vec<String>,
    pub fps: Option<u32>,
    pub action: Option<Value>,
    pub max_depth: Option<usize>,
    pub max_nodes: Option<usize>,
    pub query: Option<Query>,
    pub limit: Option<usize>,
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    pub value: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub to_x: Option<f64>,
    pub to_y: Option<f64>,
    pub button: Option<String>,
    pub key: Option<String>,
    #[serde(default)]
    pub modifiers: Vec<String>,
    pub text: Option<String>,
    pub dx: Option<f64>,
    pub dy: Option<f64>,
}
#[derive(Debug, Deserialize, Default)]
pub struct Query {
    pub role: Option<String>,
    pub name: Option<String>,
    pub text: Option<String>,
}
impl Request {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > 64 * 1024 {
            return Err(Fault::new("bounds", "Command exceeds 64 KiB"));
        }
        let r: Self = serde_json::from_slice(bytes).map_err(internal)?;
        if !(1..=2).contains(&r.version) || !valid_id(&r.id) {
            return Err(Fault::new(
                "not_supported",
                "Invalid protocol version or request id",
            ));
        }
        if r.fps.is_some_and(|n| !(1..=30).contains(&n)) {
            return Err(Fault::new("bounds", "fps must be 1..30"));
        }
        Ok(r)
    }
}
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
pub fn reply(r: &Request, result: Result<Value>) -> Value {
    match result {
        Ok(data) => json!({"version": r.version, "id": r.id, "ok": true, "data": data}),
        Err(e) if r.version == 1 => json!({"version":1,"id":r.id,"ok":false,"error":e.message}),
        Err(e) => json!({"version":2,"id":r.id,"ok":false,"error":e}),
    }
}
pub fn packet(header: &Value, jpeg: &[u8]) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(header).map_err(internal)?;
    if bytes.len() > 4096 || jpeg.is_empty() || jpeg.len() > 8 * 1024 * 1024 {
        return Err(Fault::new("bounds", "Frame exceeds limit"));
    }
    let mut out = Vec::with_capacity(4 + bytes.len() + jpeg.len());
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(&bytes);
    out.extend_from_slice(jpeg);
    Ok(out)
}
