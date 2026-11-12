//! Images and transcripts from the person's endpoints (ADR 0134): the OpenAI-format images route,
//! chat models that answer with images, and the transcription route. Plain HTTP on the same
//! client as chat calls, so redirects are never followed with a key. Answers are bounded and
//! errors are one short line that never holds the key.

use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};

use crate::catalog::{Capability, Endpoint, Model};
use crate::client::Models;
use crate::error::ModelError;
use crate::format::Format;
use crate::listing::{message_in, one_line, reason};
use crate::prompt::{Generated, Usage};

/// The most an image or transcription answer may be, in bytes.
pub const MOST_MEDIA_ANSWER: usize = 48 * 1024 * 1024;
/// The largest recording sent for transcription.
pub const MOST_AUDIO_BYTES: usize = 25 * 1024 * 1024;
/// How long one image or transcription call may take.
const MEDIA_TIMEOUT: Duration = Duration::from_secs(180);

/// A resolved call: the endpoint, the model, its key and what to scrub from errors.
struct Target {
    reference: String,
    endpoint: Endpoint,
    model: Model,
    key: Option<String>,
}

impl Target {
    fn secrets(&self) -> Vec<&str> {
        let mut secrets: Vec<&str> = self
            .endpoint
            .headers
            .iter()
            .map(|(_, v)| v.as_str())
            .collect();
        secrets.extend(self.key.as_deref());
        secrets
    }

    fn fail(&self, message: String) -> ModelError {
        ModelError::Provider {
            model: self.reference.clone(),
            message: one_line(&message, &self.secrets()),
        }
    }
}

impl Models {
    /// The first model on the person's endpoints, in their order, that has `capability`.
    pub fn first_with(&self, capability: Capability) -> Option<String> {
        self.endpoints().iter().find_map(|endpoint| {
            endpoint
                .models
                .iter()
                .find(|m| m.can(capability))
                .map(|m| format!("{}/{}", endpoint.id, m.id))
        })
    }

    async fn target(&self, reference: &str) -> Result<Target, ModelError> {
        let (endpoint, model) = self
            .resolve(reference)
            .ok_or_else(|| ModelError::UnknownModel(reference.to_owned()))?;
        let key = if endpoint.needs_key {
            Some(
                self.key_for(&endpoint)
                    .await
                    .ok_or_else(|| ModelError::MissingKey {
                        endpoint: endpoint.id.clone(),
                        var: endpoint.key_env.clone(),
                    })?,
            )
        } else {
            None
        };
        if endpoint.format == Format::Anthropic {
            return Err(ModelError::Provider {
                model: reference.to_owned(),
                message: "images and transcripts need an OpenAI-format endpoint".to_owned(),
            });
        }
        Ok(Target {
            reference: reference.to_owned(),
            endpoint,
            model,
            key,
        })
    }

    fn post(&self, target: &Target, path: &str) -> reqwest::RequestBuilder {
        let mut request = self
            .http()
            .post(format!("{}{path}", target.endpoint.base_url))
            .timeout(MEDIA_TIMEOUT);
        if let Some(key) = &target.key {
            request = request.bearer_auth(key);
        }
        for (name, value) in &target.endpoint.headers {
            request = request.header(name.as_str(), value.as_str());
        }
        request
    }

    /// Makes images from `prompt` with `reference`, a model with `image-generation` (the images
    /// route) or `image-output` (a chat model). Answers each image's bytes.
    pub async fn generate_image(
        &self,
        reference: &str,
        prompt: &str,
        size: Option<&str>,
    ) -> Result<Generated<Vec<Vec<u8>>>, ModelError> {
        let target = self.target(reference).await?;
        if target.model.can(Capability::ImageGeneration) {
            let mut body = json!({ "model": target.model.id, "prompt": prompt, "n": 1 });
            if let Some(size) = size {
                body["size"] = Value::String(size.to_owned());
            }
            let answer = send(
                &target,
                self.post(&target, "images/generations").json(&body),
            )
            .await?;
            let images = answer
                .get("data")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.get("b64_json").and_then(Value::as_str))
                        .filter_map(|data| STANDARD.decode(data.trim()).ok())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            return none_is_empty(&target, images, usage_of(&answer));
        }
        if target.model.can(Capability::ImageOutput) {
            let body = json!({
                "model": target.model.id,
                "messages": [{ "role": "user", "content": prompt }],
                "modalities": ["image", "text"],
            });
            let answer = send(&target, self.post(&target, "chat/completions").json(&body)).await?;
            let images = answer
                .pointer("/choices/0/message/images")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| {
                            item.pointer("/image_url/url")
                                .or_else(|| item.get("url"))
                                .and_then(Value::as_str)
                        })
                        .filter_map(data_url)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            return none_is_empty(&target, images, usage_of(&answer));
        }
        Err(ModelError::Provider {
            model: reference.to_owned(),
            message: "this model does not make images".to_owned(),
        })
    }

    /// The words in `audio` (of `media_type`), by `reference`: the model the person picked to
    /// transcribe. Their choice is what counts, not the `transcription` capability.
    pub async fn transcribe(
        &self,
        reference: &str,
        audio: Vec<u8>,
        media_type: &str,
    ) -> Result<Generated<String>, ModelError> {
        let target = self.target(reference).await?;
        if audio.len() > MOST_AUDIO_BYTES {
            return Err(target.fail("the recording is larger than 25 MB".to_owned()));
        }
        let name = format!("voice.{}", extension(media_type));
        let part = reqwest::multipart::Part::bytes(audio)
            .file_name(name)
            .mime_str(media_type)
            .map_err(|_| target.fail("the recording's type is not valid".to_owned()))?;
        let form = reqwest::multipart::Form::new()
            .text("model", target.model.id.clone())
            .text("response_format", "json")
            .part("file", part);
        let answer = send(
            &target,
            self.post(&target, "audio/transcriptions").multipart(form),
        )
        .await?;
        let text = answer
            .get("text")
            .and_then(Value::as_str)
            .map(|text| text.trim().to_owned())
            .ok_or_else(|| target.fail("the endpoint sent no transcript".to_owned()))?;
        Ok(Generated {
            value: text,
            usage: usage_of(&answer),
        })
    }
}

fn none_is_empty(
    target: &Target,
    images: Vec<Vec<u8>>,
    usage: Usage,
) -> Result<Generated<Vec<Vec<u8>>>, ModelError> {
    if images.is_empty() {
        return Err(target.fail("the endpoint sent no image".to_owned()));
    }
    Ok(Generated {
        value: images,
        usage,
    })
}

/// The tokens an answer reports: `input_tokens`/`output_tokens` (images and transcription
/// routes) or `prompt_tokens`/`completion_tokens` (chat).
fn usage_of(answer: &Value) -> Usage {
    let usage = answer.get("usage");
    let count = |keys: [&str; 2]| {
        keys.iter().find_map(|key| {
            usage
                .and_then(|u| u.get(*key))
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok())
        })
    };
    Usage {
        input_tokens: count(["input_tokens", "prompt_tokens"]),
        output_tokens: count(["output_tokens", "completion_tokens"]),
        ..Usage::default()
    }
}

/// The file extension endpoints expect for a recording's media type.
fn extension(media_type: &str) -> &'static str {
    match media_type.split(';').next().unwrap_or("").trim() {
        "audio/ogg" => "ogg",
        "audio/mp4" | "audio/m4a" | "audio/x-m4a" => "m4a",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/wav" | "audio/x-wav" | "audio/wave" => "wav",
        _ => "webm",
    }
}

/// The bytes of a base64 `data:` URL. Any other address is refused: Spade never fetches one an
/// endpoint hands back.
fn data_url(url: &str) -> Option<Vec<u8>> {
    let (prefix, data) = url.split_once(";base64,")?;
    if !prefix.starts_with("data:") {
        return None;
    }
    STANDARD.decode(data.trim()).ok()
}

/// Sends `request` and reads a bounded JSON answer.
async fn send(target: &Target, request: reqwest::RequestBuilder) -> Result<Value, ModelError> {
    let mut response = request
        .send()
        .await
        .map_err(|e| target.fail(format!("could not reach the endpoint: {}", reason(&e))))?;
    let status = response.status();
    if status.is_redirection() {
        return Err(target.fail(format!(
            "the endpoint redirected ({}); Spade does not follow redirects with your key",
            status.as_u16()
        )));
    }
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > MOST_MEDIA_ANSWER {
                    return Err(target.fail("the answer is larger than 48 MB".to_owned()));
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) => {
                return Err(target.fail(format!("the answer did not arrive: {}", reason(&e))));
            }
        }
    }
    if !status.is_success() {
        let detail = message_in(&body).map_or_else(String::new, |m| format!(": {m}"));
        return Err(target.fail(format!("the endpoint answered {}{detail}", status.as_u16())));
    }
    serde_json::from_slice(&body).map_err(|_| target.fail("the answer is not JSON".to_owned()))
}
