use crate::{
    coordinates::Bounds,
    errors::{Code, Error, Result},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, Write};
pub const MAX_LINE: usize = 64 * 1024;
pub const MAX_REPLY: usize = 1024 * 1024;
pub const MAX_FRAME: usize = 8 * 1024 * 1024;
#[derive(Debug, Deserialize)]
pub struct Request {
    pub version: u8,
    pub id: String,
    pub op: String,
    #[serde(flatten)]
    pub fields: serde_json::Map<String, Value>,
}
impl Request {
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_LINE {
            return Err(Error::new(Code::Bounds, "Command too large"));
        }
        let request: Self =
            serde_json::from_slice(bytes).map_err(|e| Error::new(Code::Bounds, e.to_string()))?;
        if ![1, 2].contains(&request.version)
            || request.id.is_empty()
            || request.id.len() > 64
            || !request
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(Error::new(
                Code::NotSupported,
                "Invalid version or request id",
            ));
        }
        Ok(request)
    }
    pub fn get<T: serde::de::DeserializeOwned>(&self, key: &str) -> Result<T> {
        serde_json::from_value(self.fields.get(key).cloned().unwrap_or(Value::Null))
            .map_err(|e| Error::new(Code::Bounds, format!("{key}: {e}")))
    }
}
pub fn read_line(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let chunk = reader
            .fill_buf()
            .map_err(|e| Error::new(Code::Internal, e.to_string()))?;
        if chunk.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Err(Error::new(Code::Bounds, "Incomplete command"))
            };
        }
        let end = chunk.iter().position(|b| *b == b'\n');
        let count = end.unwrap_or(chunk.len());
        if line.len() + count > MAX_LINE {
            return Err(Error::new(Code::Bounds, "Command too large"));
        }
        line.extend_from_slice(&chunk[..count]);
        reader.consume(count + usize::from(end.is_some()));
        if end.is_some() {
            return Ok(Some(line));
        }
    }
}
pub fn reply(writer: &mut impl Write, request: &Request, result: Result<Value>) -> Result<()> {
    let value = match result {
        Ok(data) => {
            serde_json::json!({"version": request.version, "id": request.id, "ok": true, "data": data})
        }
        Err(error) => serde_json::json!({"version": request.version, "id": request.id, "ok": false,
            "error": if request.version == 1 { Value::String(error.message) } else { serde_json::to_value(error).unwrap_or(Value::Null) }}),
    };
    let mut bytes =
        serde_json::to_vec(&value).map_err(|e| Error::new(Code::Internal, e.to_string()))?;
    if bytes.len() > MAX_REPLY {
        return reply(
            writer,
            request,
            Err(Error::new(Code::Bounds, "Reply too large")),
        );
    }
    bytes.push(b'\n');
    writer
        .write_all(&bytes)
        .and_then(|_| writer.flush())
        .map_err(|e| Error::new(Code::Internal, e.to_string()))
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    pub version: u8,
    pub session_id: String,
    pub seq: u64,
    pub ts: f64,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub codec: String,
    pub bytes: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dirty_rects: Option<Vec<Bounds>>,
}
pub fn packet(header: &Header, payload: &[u8]) -> Result<Vec<u8>> {
    if header.bytes != payload.len()
        || payload.is_empty()
        || payload.len() > MAX_FRAME
        || header.width == 0
        || header.width > 3840
        || header.height == 0
        || header.height > 2160
        || !header.ts.is_finite()
        || header.ts < 0.0
        || !header.scale.is_finite()
        || header.scale <= 0.0
        || header.seq > 9_007_199_254_740_991
        || header.codec != "jpeg"
        || ![1, 2].contains(&header.version)
    {
        return Err(Error::new(Code::Bounds, "Invalid frame"));
    }
    let json = if header.version == 1 {
        serde_json::to_vec(&serde_json::json!({"version":1,"sessionId":header.session_id,"sequence":header.seq,
            "timestamp":header.ts,"width":header.width,"height":header.height,"codec":"jpeg","bytes":header.bytes}))
    } else { serde_json::to_vec(header) }.map_err(|e| Error::new(Code::Internal, e.to_string()))?;
    if json.len() > 4096 {
        return Err(Error::new(Code::Bounds, "Frame header too large"));
    }
    let mut bytes = Vec::with_capacity(4 + json.len() + payload.len());
    bytes.extend_from_slice(&(json.len() as u32).to_be_bytes());
    bytes.extend(json);
    bytes.extend_from_slice(payload);
    Ok(bytes)
}
pub fn jpeg(rgb: &[u8], width: u32, height: u32) -> Result<Vec<u8>> {
    if width == 0
        || height == 0
        || width > 3840
        || height > 2160
        || rgb.len() != width as usize * height as usize * 3
    {
        return Err(Error::new(Code::Bounds, "Invalid RGB buffer"));
    }
    let mut bytes = Vec::with_capacity(rgb.len() / 8);
    jpeg_encoder::Encoder::new(&mut bytes, 75)
        .encode(
            rgb,
            width as u16,
            height as u16,
            jpeg_encoder::ColorType::Rgb,
        )
        .map_err(|e| Error::new(Code::Internal, e.to_string()))?;
    if bytes.len() > MAX_FRAME {
        return Err(Error::new(Code::Bounds, "JPEG too large"));
    }
    Ok(bytes)
}
