//! Images and transcripts from the person's endpoints (ADR 0134), against a local fake.

use serde_json::json;
use spade_models::{Capability, Catalog, Endpoint, Format, Keys, Model, ModelError, Models};
use spade_testkit::FakeMedia;

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

const KEY: &str = "sk-media-secret";
const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfake";

fn model(id: &str, capabilities: Vec<Capability>) -> Model {
    Model {
        capabilities,
        ..Model::unknown(id)
    }
}

fn models(root: &str, format: Format) -> Result<Models> {
    let presets = Catalog::from_json(&json!({ "endpoints": [] }).to_string())?;
    let models = Models::new(presets, Keys::new(|_| Some(KEY.to_owned())), "9.9.9")?;
    models.set_endpoints(vec![Endpoint {
        id: "mine".into(),
        name: "Mine".into(),
        format,
        base_url: root.to_owned(),
        needs_key: true,
        key_env: None,
        headers: Vec::new(),
        session_header: None,
        models: vec![
            model("chat", vec![Capability::Tools]),
            model("painter", vec![Capability::ImageGeneration]),
            model("talker", vec![Capability::ImageOutput]),
            model("ears", vec![Capability::Transcription]),
        ],
    }]);
    Ok(models)
}

#[tokio::test]
async fn an_images_route_model_makes_an_image_from_a_prompt() -> Result {
    let fake = FakeMedia::start(PNG, "").await?;
    let models = models(&fake.root, Format::OpenAiChat)?;
    let images = models
        .generate_image("mine/painter", "a red kite", Some("1024x1024"))
        .await?;
    assert_eq!(images, vec![PNG.to_vec()]);
    let seen = fake.seen();
    assert_eq!(seen[0].path, "/images/generations");
    assert_eq!(
        seen[0].authorization.as_deref(),
        Some(format!("Bearer {KEY}").as_str())
    );
    let body: serde_json::Value = serde_json::from_slice(&seen[0].body)?;
    assert_eq!(body["model"], "painter");
    assert_eq!(body["prompt"], "a red kite");
    assert_eq!(body["size"], "1024x1024");
    Ok(())
}

#[tokio::test]
async fn a_chat_model_with_image_output_answers_with_data_urls_only() -> Result {
    let fake = FakeMedia::start(PNG, "").await?;
    let models = models(&fake.root, Format::OpenAiChat)?;
    // The fake also offers an https address, which is never fetched.
    let images = models.generate_image("mine/talker", "a kite", None).await?;
    assert_eq!(images, vec![PNG.to_vec()]);
    let body: serde_json::Value = serde_json::from_slice(&fake.seen()[0].body)?;
    assert_eq!(body["modalities"], json!(["image", "text"]));
    assert_eq!(fake.seen().len(), 1);
    Ok(())
}

#[tokio::test]
async fn a_model_without_the_capability_makes_no_image_and_hears_nothing() -> Result {
    let fake = FakeMedia::start(PNG, "words").await?;
    let models = models(&fake.root, Format::OpenAiChat)?;
    assert!(matches!(
        models.generate_image("mine/chat", "x", None).await,
        Err(ModelError::Provider { .. })
    ));
    assert!(
        models
            .transcribe("mine/chat", vec![1, 2], "audio/webm")
            .await
            .is_err()
    );
    assert!(fake.seen().is_empty());
    assert_eq!(
        models.first_with(Capability::ImageGeneration).as_deref(),
        Some("mine/painter")
    );
    assert_eq!(models.first_with(Capability::PdfInput), None);
    Ok(())
}

#[tokio::test]
async fn a_recording_is_sent_as_a_file_and_its_transcript_comes_back() -> Result {
    let fake = FakeMedia::start(PNG, "lights off please").await?;
    let models = models(&fake.root, Format::OpenAiResponses)?;
    let text = models
        .transcribe("mine/ears", b"OggS fake audio".to_vec(), "audio/ogg")
        .await?;
    assert_eq!(text, "lights off please");
    let seen = &fake.seen()[0];
    assert_eq!(seen.path, "/audio/transcriptions");
    assert!(
        seen.content_type
            .as_deref()
            .unwrap_or("")
            .starts_with("multipart/form-data")
    );
    let body = seen.text();
    assert!(body.contains("name=\"model\"\r\n\r\nears"), "{body}");
    assert!(body.contains("filename=\"voice.ogg\""), "{body}");
    assert!(body.contains("OggS fake audio"), "{body}");
    Ok(())
}

#[tokio::test]
async fn an_anthropic_format_endpoint_is_refused_for_media() -> Result {
    let fake = FakeMedia::start(PNG, "").await?;
    let models = models(&fake.root, Format::Anthropic)?;
    assert!(
        models
            .generate_image("mine/painter", "x", None)
            .await
            .is_err()
    );
    assert!(fake.seen().is_empty());
    Ok(())
}
