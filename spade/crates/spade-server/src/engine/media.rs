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
    /// Devices the person named with `@` (ADR 0198).
    pub devices: Vec<spade_core::named_devices::NamedDevice>,
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
        self.check_message(&outgoing.text, attached)?;
        if let Some((name, machine)) = self.moving_to(id) {
            return Err(SendError::Moving(name, machine));
        }
        if !self.reachable(id)? || self.deleting(id) {
            return Err(SendError::NotFound);
        }
        if self.disabled_main(id)? {
            return Err(SendError::Disabled);
        }
        // A group's conversation is written to through the group (ADR 0132).
        if self.store.group_for_conversation(id)?.is_some() {
            return Err(SendError::Group);
        }
        // A helper hears only its task (ADR 0152).
        if self.helper_of(id).is_some() {
            return Err(SendError::Helper);
        }
        // Until the person chooses a model nothing could answer: the message is not posted.
        if self.lacks_model(id) {
            return Err(SendError::NoModel);
        }
        let outgoing_devices = outgoing.devices.clone();
        let images = outgoing
            .images
            .iter()
            .map(|bytes| self.put_image(bytes))
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
            from_thread: None,
        });
        let message = memory::with_recall(self, id, message);
        let message = with_devices(message, &outgoing_devices);
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

    /// The words in a recording, from the person's transcription model; what it cost is
    /// recorded like any model call.
    pub async fn transcribe(&self, audio: Vec<u8>) -> Result<String, TranscribeError> {
        let model = self.transcription_model()?.ok_or(TranscribeError::NotSet)?;
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
    /// call, in the same ledger as model calls.
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

/// The message with the devices the person named put first in its per-turn context.
fn with_devices(event: Event, devices: &[spade_core::named_devices::NamedDevice]) -> Event {
    let Some(named) = spade_core::named_devices::context(devices) else {
        return event;
    };
    match event {
        Event::Known(Known::UserMessage {
            text,
            context,
            images,
            documents,
            voice,
            from_agent,
            from_routine,
            from_group,
            from_thread,
        }) => Event::Known(Known::UserMessage {
            text,
            context: Some(match context {
                Some(recalled) => format!("{named}\n\n{recalled}"),
                None => named,
            }),
            images,
            documents,
            voice,
            from_agent,
            from_routine,
            from_group,
            from_thread,
        }),
        other => other,
    }
}
