//! Words read aloud by the person's own endpoint (ADR 0134, amended): the OpenAI-format
//! `POST /audio/speech` route. The audio is handed on as it arrives, so the app can start
//! playing before the endpoint has finished; the whole answer is bounded, and errors are one
//! short line that never holds the key.

use std::pin::Pin;

use futures_util::Stream;
use serde_json::{Value, json};

use crate::client::Models;
use crate::error::ModelError;
use crate::listing::{message_in, one_line, reason};

/// The most characters one speech call reads (the OpenAI route's own limit).
pub const MOST_SPEECH_CHARS: usize = 4_096;
/// The most audio one speech call may answer, in bytes.
pub const MOST_SPEECH_BYTES: usize = 16 * 1024 * 1024;
/// The most of an error answer read for its message.
const MOST_ERROR_BYTES: usize = 64 * 1024;

/// What to read aloud, and how.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpeechRequest<'a> {
    pub text: &'a str,
    /// The endpoint's name for a voice ("alloy").
    pub voice: &'a str,
    /// How to speak (tone, pace), for models that take it; others ignore it.
    pub instructions: Option<&'a str>,
}

/// An endpoint's spoken answer: its media type, and its bytes as they arrive.
pub struct Speech {
    pub media_type: String,
    pub chunks: Pin<Box<dyn Stream<Item = Result<Vec<u8>, ModelError>> + Send>>,
}

/// What a failure mid-stream says, without the key.
struct Failing {
    reference: String,
    secrets: Vec<String>,
}

impl Failing {
    fn fail(&self, message: &str) -> ModelError {
        let secrets: Vec<&str> = self.secrets.iter().map(String::as_str).collect();
        ModelError::Provider {
            model: self.reference.clone(),
            message: one_line(message, &secrets),
        }
    }
}

impl Models {
    /// Reads `request.text` aloud with `reference`, the model the person picked to speak. Their
    /// choice is what counts, not the `speech` capability. Answers once the endpoint has accepted
    /// the call; its audio then streams.
    pub async fn speak(
        &self,
        reference: &str,
        request: SpeechRequest<'_>,
    ) -> Result<Speech, ModelError> {
        let target = self.target(reference).await?;
        if request.text.trim().is_empty() {
            return Err(target.fail("there are no words to read".to_owned()));
        }
        if request.text.chars().count() > MOST_SPEECH_CHARS {
            return Err(target.fail(format!(
                "the words are longer than {MOST_SPEECH_CHARS} characters"
            )));
        }
        let mut body = json!({
            "model": target.model.id,
            "input": request.text,
            "voice": request.voice,
            "response_format": "mp3",
        });
        if let Some(instructions) = request.instructions.filter(|i| !i.trim().is_empty()) {
            body["instructions"] = Value::String(instructions.to_owned());
        }
        let mut response = self
            .post(&target, "audio/speech")
            .json(&body)
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
        if !status.is_success() {
            let body = bounded(&mut response, MOST_ERROR_BYTES).await;
            let detail = message_in(&body).map_or_else(String::new, |m| format!(": {m}"));
            return Err(target.fail(format!("the endpoint answered {}{detail}", status.as_u16())));
        }
        let media_type = media_type(&response).ok_or_else(|| {
            target.fail("the endpoint answered with something other than audio".to_owned())
        })?;
        let failing = Failing {
            reference: target.reference.clone(),
            secrets: target.secrets().into_iter().map(str::to_owned).collect(),
        };
        let chunks = futures_util::stream::try_unfold(
            (response, 0usize, failing),
            |(mut response, sent, failing)| async move {
                match response.chunk().await {
                    Ok(Some(chunk)) => {
                        let sent = sent + chunk.len();
                        if sent > MOST_SPEECH_BYTES {
                            return Err(failing.fail("the audio is larger than 16 MB"));
                        }
                        Ok(Some((chunk.to_vec(), (response, sent, failing))))
                    }
                    Ok(None) => Ok(None),
                    Err(e) => {
                        Err(failing.fail(&format!("the audio stopped arriving: {}", reason(&e))))
                    }
                }
            },
        );
        Ok(Speech {
            media_type,
            chunks: Box::pin(chunks),
        })
    }
}

/// The answer's audio type. Endpoints that send bytes untyped get the type that was asked for.
fn media_type(response: &reqwest::Response) -> Option<String> {
    let given = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match given.as_str() {
        "" | "application/octet-stream" | "binary/octet-stream" => Some("audio/mpeg".to_owned()),
        audio if audio.starts_with("audio/") => Some(audio.to_owned()),
        _ => None,
    }
}

/// Up to `most` bytes of an answer, for its error message.
async fn bounded(response: &mut reqwest::Response, most: usize) -> Vec<u8> {
    let mut body = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        body.extend_from_slice(&chunk);
        if body.len() >= most {
            body.truncate(most);
            break;
        }
    }
    body
}
