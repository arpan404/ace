//! Images the person attaches reach the model in each wire format, after the text.

use serde_json::{Value, json};
use spade_models::{Catalog, Image, Keys, Models, Prompt};
use spade_testkit::{FakeProvider, Script};

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

fn models(fake: &FakeProvider) -> Result<Models> {
    let json = json!({
        "roles": { "main": "chat/kimi", "fast": "chat/kimi", "deep": "chat/kimi" },
        "endpoints": [
            { "id": "chat", "name": "Chat", "format": "openai-chat", "base_url": fake.root,
              "key": { "env": "K" }, "models": [ { "id": "kimi", "name": "Kimi" } ] },
            { "id": "msgs", "name": "Messages", "format": "anthropic", "base_url": fake.root,
              "key": { "env": "K" }, "models": [ { "id": "opus", "name": "Opus" } ] }
        ]
    });
    Ok(Models::new(
        Catalog::from_json(&json.to_string())?,
        Keys::new(|_| Some("key".to_owned())),
        "test",
    )?)
}

fn photo() -> Image {
    Image {
        media_type: "image/png".into(),
        data: "iVBORw0KGgo=".into(),
    }
}

fn user_content(fake: &FakeProvider) -> Value {
    fake.seen()
        .last()
        .and_then(|s| {
            s.body["messages"]
                .as_array()
                .and_then(|m| m.iter().find(|m| m["role"] == "user").cloned())
        })
        .map(|m| m["content"].clone())
        .unwrap_or(Value::Null)
}

#[tokio::test]
async fn an_attached_image_follows_the_text_in_openai_chat_and_anthropic() -> Result {
    let fake = FakeProvider::start_with(Script::reply("A cat.")).await?;
    let models = models(&fake)?;
    let prompt = Prompt::default().person_with_images("What is this?", vec![photo()]);

    models.chat("chat/kimi", &prompt).await?;
    let chat = user_content(&fake);
    assert_eq!(chat[0]["type"], "text");
    assert_eq!(chat[0]["text"], "What is this?");
    assert_eq!(chat[1]["type"], "image_url");
    assert_eq!(
        chat[1]["image_url"]["url"],
        "data:image/png;base64,iVBORw0KGgo="
    );

    models.chat("msgs/opus", &prompt).await?;
    let messages = user_content(&fake);
    assert_eq!(messages[0]["text"], "What is this?");
    assert_eq!(
        messages[1],
        json!({ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo=" } })
    );
    Ok(())
}
