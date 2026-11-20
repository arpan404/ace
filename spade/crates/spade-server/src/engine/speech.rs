//! Replies read aloud by the person's own endpoint (ADR 0134, amended): the speech model
//! setting and the call that streams its audio. The app chooses what to read and when; the
//! server only carries the words to the endpoint the person picked, with its key.

use spade_models::{Speech, SpeechRequest};

use super::Engine;

/// The setting naming the model that reads replies aloud (`endpoint/model`).
const SPEECH_MODEL: &str = "speech_model";
/// The voice used when the app names none.
pub const DEFAULT_VOICE: &str = "alloy";

#[derive(Debug, thiserror::Error)]
pub enum SpeakError {
    #[error("no speech model is set; pick one in Spade's settings")]
    NotSet,
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Model(String),
    #[error(transparent)]
    Store(#[from] spade_store::StoreError),
}

/// What the app asks to hear.
#[derive(Debug, Clone, Default)]
pub struct SpeakRequest {
    pub text: String,
    pub voice: Option<String>,
    pub instructions: Option<String>,
}

/// A voice is the endpoint's own short name for it: letters, digits, `-`, `_` and `.`.
fn valid_voice(voice: &str) -> bool {
    (1..=64).contains(&voice.len())
        && voice
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}

impl Engine {
    /// The model that reads replies aloud, when the person picked one.
    pub fn speech_model(&self) -> Result<Option<String>, spade_store::StoreError> {
        self.store.setting(SPEECH_MODEL)
    }

    /// Sets (or with `None` clears) the model that reads replies aloud; it must be on one of
    /// the person's endpoints. A subscription model has no speech route.
    pub fn set_speech_model(&self, model: Option<&str>) -> Result<(), super::AgentError> {
        if model.is_some_and(|m| spade_core::brain::CliModel::is(m.trim())) {
            return Err(super::AgentError::Invalid(
                "a subscription model can't read aloud; pick a model on an endpoint".to_owned(),
            ));
        }
        let model = model.map(|m| self.check_model(m)).transpose()?;
        Ok(self.store.set_setting(SPEECH_MODEL, model.as_deref())?)
    }

    /// Starts reading `request.text` aloud with the person's speech model. Answers once the
    /// endpoint accepted the call; what it costs per call is recorded then.
    pub async fn speak(&self, request: SpeakRequest) -> Result<Speech, SpeakError> {
        let model = self.speech_model()?.ok_or(SpeakError::NotSet)?;
        let voice = request.voice.as_deref().unwrap_or(DEFAULT_VOICE);
        if !valid_voice(voice) {
            return Err(SpeakError::Invalid(
                "that voice name isn't valid".to_owned(),
            ));
        }
        if request.text.trim().is_empty() {
            return Err(SpeakError::Invalid("there are no words to read".to_owned()));
        }
        if request.text.chars().count() > spade_models::MOST_SPEECH_CHARS {
            return Err(SpeakError::Invalid(format!(
                "at most {} characters are read at once",
                spade_models::MOST_SPEECH_CHARS
            )));
        }
        let speech = self
            .models
            .speak(
                &model,
                SpeechRequest {
                    text: &request.text,
                    voice,
                    instructions: request.instructions.as_deref(),
                },
            )
            .await
            .map_err(|error| SpeakError::Model(error.to_string()))?;
        // Not tied to a conversation: the app reads what it already shows.
        self.pay_call("", &model, &spade_models::Usage::default());
        Ok(speech)
    }
}

#[cfg(test)]
mod tests {
    use super::valid_voice;

    #[test]
    fn a_voice_is_a_short_plain_name() {
        for good in ["alloy", "en_US-amy", "af.heart", "v2"] {
            assert!(valid_voice(good), "{good}");
        }
        for bad in ["", "two words", "../x", "a\nb", &"x".repeat(65)] {
            assert!(!valid_voice(bad), "{bad:?}");
        }
    }
}
