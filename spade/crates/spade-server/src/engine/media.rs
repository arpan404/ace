//! Messages with documents and voice (ADR 0134), and the stores tools reach through the engine.

use std::sync::Arc;

use spade_core::Event;
use spade_core::event::{DocumentRef, Known, VoiceRef};

use super::{Engine, SendError, memory};
use crate::images::ImageStore;
use crate::media::{MOST_DOCUMENTS, Media};

/// What the person sends: words, images as bytes, and documents and a recording already stored
/// (reading a document is slow, so the API does it before the message is sent).
#[derive(Debug, Clone, Default)]
pub struct Outgoing {
    pub text: String,
    pub images: Vec<Vec<u8>>,
    pub documents: Vec<DocumentRef>,
    /// The recording, when the message was spoken; `text` is its transcript.
    pub voice: Option<VoiceRef>,
}

impl Engine {
    /// Sends a message. While a reply is open it steers that turn; otherwise it starts one.
    pub fn send_message(self: &Arc<Self>, id: &str, outgoing: Outgoing) -> Result<(), SendError> {
        if outgoing.images.len() > crate::images::MOST_IMAGES {
            return Err(SendError::TooManyImages);
        }
        if outgoing.documents.len() > MOST_DOCUMENTS {
            return Err(SendError::TooManyDocuments);
        }
        let attached = outgoing.images.len() + outgoing.documents.len();
        self.check_message(id, &outgoing.text, attached)?;
        if self.store.conversation(id)?.is_none() || self.deleting(id) {
            return Err(SendError::NotFound);
        }
        if self.disabled_main(id)? {
            return Err(SendError::Disabled);
        }
        // A group's conversation is written to through the group (ADR 0132).
        if self.store.group_for_conversation(id)?.is_some() {
            return Err(SendError::Group);
        }
        let images = outgoing
            .images
            .iter()
            .map(|bytes| self.images.put(bytes))
            .collect::<Result<Vec<_>, _>>()?;
        let message = Event::Known(Known::UserMessage {
            text: outgoing.text.trim().to_owned(),
            context: None,
            images,
            documents: outgoing.documents,
            voice: outgoing.voice.map(Box::new),
            from_agent: None,
            from_routine: None,
            from_group: None,
        });
        let message = memory::with_recall(self, id, message);
        self.deliver(id, &message)?;
        Ok(())
    }

    /// Attached documents and recordings.
    pub fn media(&self) -> &Media {
        &self.media
    }

    /// Where images are kept.
    pub fn image_store(&self) -> &ImageStore {
        &self.images
    }

    /// A stored document's bytes, by hash.
    pub fn document(&self, sha256: &str) -> Option<Vec<u8>> {
        self.media.documents.bytes(sha256)
    }
}

/// The setting naming the model that transcribes voice (`endpoint/model`).
const TRANSCRIPTION_MODEL: &str = "transcription_model";

#[derive(Debug, thiserror::Error)]
pub enum TranscribeError {
    #[error("no transcription model is set; pick one in Spade's settings")]
    NotSet,
    #[error(transparent)]
    Audio(#[from] crate::media::AudioError),
    #[error("{0}")]
    Model(String),
    #[error("today's spending cap is used up")]
    OverCap,
    #[error(transparent)]
    Store(#[from] spade_store::StoreError),
}

impl Engine {
    /// The model that transcribes voice, when the person picked one.
    pub fn transcription_model(&self) -> Result<Option<String>, spade_store::StoreError> {
        self.store.setting(TRANSCRIPTION_MODEL)
    }

    /// Sets (or with `None` clears) the model that transcribes voice; it must be on one of the
    /// person's endpoints.
    pub fn set_transcription_model(&self, model: Option<&str>) -> Result<(), super::AgentError> {
        let model = model.map(|m| self.check_model(m)).transpose()?;
        Ok(self
            .store
            .set_setting(TRANSCRIPTION_MODEL, model.as_deref())?)
    }

    /// The words in a recording, from the person's transcription model. Refused once today's
    /// cap is spent; what it cost is recorded like any model call.
    pub async fn transcribe(&self, audio: Vec<u8>) -> Result<String, TranscribeError> {
        let model = self.transcription_model()?.ok_or(TranscribeError::NotSet)?;
        if !self.within_cap()? {
            return Err(TranscribeError::OverCap);
        }
        if audio.len() > crate::media::audio::MOST_AUDIO_BYTES {
            return Err(crate::media::AudioError::TooLarge.into());
        }
        let media_type =
            crate::media::audio::sniff(&audio).ok_or(crate::media::AudioError::NotAudio)?;
        let heard = self
            .models
            .transcribe(&model, audio, media_type)
            .await
            .map_err(|error| TranscribeError::Model(error.to_string()))?;
        // Not tied to a conversation: the recording is not sent yet.
        self.pay_call("", &model, &heard.usage);
        Ok(heard.value)
    }

    /// Records what an image or transcription call cost (ADR 0134): its tokens and its price per
    /// call, in the same ledger as model calls, so the daily cap counts it.
    pub(crate) fn pay_call(&self, conversation: &str, model: &str, usage: &spade_models::Usage) {
        let cost = spade_core::spending::call_cost_micros(self.models.price(model), usage);
        if cost > 0
            && let Err(error) = self
                .store
                .record_spend(conversation, model, cost, self.now_ms())
        {
            tracing::error!(%error, "could not record what a media call cost");
        }
    }
}
