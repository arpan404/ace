//! The media tools (ADR 0134): `document_read` reads more of an attached document,
//! `share_file` shows a workspace file to the person, and `image_generate` makes an image, offered
//! only while one of the person's models can.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::context::DOCUMENT_READ;
use spade_core::tools::{Risk, ToolDef};
use spade_models::{Capability, ToolSpec};

use super::documents::WINDOW_CHARS;
use crate::tools::{EngineHandle, Shared, Tool, ToolFuture, ToolOutput, ToolSource, parse};
use crate::workspace::Workspaces;

pub const SHARE_FILE: &str = "share_file";
pub const IMAGE_GENERATE: &str = "image_generate";

fn def(name: &str, description: &str, schema: Value, risk: Risk, untrusted: bool) -> ToolDef {
    ToolDef {
        spec: ToolSpec {
            name: name.to_owned(),
            description: description.to_owned(),
            schema,
        },
        risk,
        untrusted_output: untrusted,
        deferred: false,
        background: false,
    }
}

/// The calling conversation, from a call's key (`<conversation>.<call>`).
fn conversation(key: &str) -> &str {
    key.split_once('.')
        .map_or(key, |(conversation, _)| conversation)
}

/// `document_read` and `share_file`, for the bots `engine` finds (set once it exists).
pub fn all(workspaces: Workspaces, engine: EngineHandle) -> Vec<Arc<dyn Tool>> {
    vec![
        Arc::new(DocumentRead(engine.clone())),
        Arc::new(ShareFile { workspaces, engine }),
    ]
}

/// The source that offers `image_generate` while a model can make images.
pub fn images(engine: &EngineHandle) -> Arc<dyn ToolSource> {
    Arc::new(ImageSource(engine.clone()))
}

pub struct DocumentRead(pub EngineHandle);

#[derive(Deserialize)]
struct ReadArgs {
    id: String,
    #[serde(default)]
    offset: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
}

impl Tool for DocumentRead {
    fn def(&self) -> ToolDef {
        def(
            DOCUMENT_READ,
            "Read more of a document the person attached, by the id shown with it. Text comes in \
             windows: pass the offset given at the end to read on.",
            json!({ "type": "object",
                    "properties": { "id": { "type": "string" },
                                    "offset": { "type": "integer", "minimum": 0 },
                                    "limit": { "type": "integer", "minimum": 1,
                                               "maximum": WINDOW_CHARS } },
                    "required": ["id"] }),
            Risk::Read,
            true,
        )
    }

    fn run(&self, _key: &str, arguments: Value) -> ToolFuture {
        let engine = self.0.get();
        Box::pin(async move {
            let args: ReadArgs = match parse(arguments) {
                Ok(args) => args,
                Err(output) => return output,
            };
            let Some(engine) = engine else {
                return ToolOutput::error("Spade is stopping.");
            };
            let offset = args.offset.unwrap_or(0);
            let limit = args.limit.unwrap_or(WINDOW_CHARS);
            let documents = engine.media().documents.clone();
            let id = args.id.clone();
            let window = tokio::task::spawn_blocking(move || documents.window(&id, offset, limit))
                .await
                .ok()
                .flatten();
            let Some(window) = window else {
                return ToolOutput::error(format!(
                    "No attached document has the id {}.",
                    args.id.chars().take(70).collect::<String>()
                ));
            };
            let mut out = window.text;
            match window.next_offset {
                Some(next) => out.push_str(&format!(
                    "\n[{next} of {} characters read; read on with offset {next}]",
                    window.total_chars
                )),
                None => out.push_str(&format!(
                    "\n[End of the document, {} characters.]",
                    window.total_chars
                )),
            }
            ToolOutput::ok(out)
        })
    }
}

/// `share_file`: shows a file from the bot's workspace to the person, an image as an image and
/// anything Spade reads as a document.
pub struct ShareFile {
    pub workspaces: Workspaces,
    pub engine: EngineHandle,
}

#[derive(Deserialize)]
struct ShareArgs {
    path: String,
}

impl Tool for ShareFile {
    fn def(&self) -> ToolDef {
        def(
            SHARE_FILE,
            "Show the person a file from your workspace, such as a chart or diagram you made: an \
             image appears in your message, any other file as a document they can open and \
             download.",
            json!({ "type": "object", "properties": { "path": { "type": "string" } },
                    "required": ["path"] }),
            Risk::Read,
            false,
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let engine = self.engine.get();
        let workspace = self
            .engine
            .agent_for_key(key)
            .map(|bot| self.workspaces.of(&bot));
        Box::pin(async move {
            let args: ShareArgs = match parse(arguments) {
                Ok(args) => args,
                Err(output) => return output,
            };
            let (Some(engine), Some(Ok(workspace))) = (engine, workspace) else {
                return ToolOutput::error("This conversation has no workspace.");
            };
            let largest = spade_docs::Limits::default().file_bytes as u64;
            let path = args.path.clone();
            let read =
                tokio::task::spawn_blocking(move || workspace.bytes_up_to(&path, largest)).await;
            let bytes = match read {
                Ok(Ok(bytes)) => bytes,
                Ok(Err(error)) => return ToolOutput::error(error.to_string()),
                Err(_) => return ToolOutput::error("The file could not be read."),
            };
            let name = super::documents::file_name(&args.path);
            let mut shared = Shared::default();
            if crate::images::sniff(&bytes).is_some() {
                match engine.image_store().put(&bytes) {
                    Ok(image) => shared.images.push(image),
                    Err(error) => return ToolOutput::error(format!("{name}: {error}")),
                }
            } else {
                match engine.media().attach(&name, bytes).await {
                    Ok(document) => shared.documents.push(document),
                    Err(error) => return ToolOutput::error(error.to_string()),
                }
            }
            ToolOutput {
                shared,
                ..ToolOutput::ok(format!("Shown to the person: {name}."))
            }
        })
    }
}

/// Offers `image_generate` only while one of the person's models makes images.
pub struct ImageSource(pub EngineHandle);

impl ToolSource for ImageSource {
    fn tools(&self) -> Vec<Arc<dyn Tool>> {
        let Some(engine) = self.0.get() else {
            return Vec::new();
        };
        let models = engine.models();
        if models.first_with(Capability::ImageGeneration).is_none()
            && models.first_with(Capability::ImageOutput).is_none()
        {
            return Vec::new();
        }
        vec![Arc::new(ImageGenerate(self.0.clone()))]
    }
}

pub struct ImageGenerate(EngineHandle);

#[derive(Deserialize)]
struct ImageArgs {
    prompt: String,
    #[serde(default)]
    size: Option<String>,
}

impl Tool for ImageGenerate {
    fn def(&self) -> ToolDef {
        let def = def(
            IMAGE_GENERATE,
            "Make an image from a description and show it to the person. Optionally give a size \
             such as 1024x1024.",
            json!({ "type": "object",
                    "properties": { "prompt": { "type": "string" },
                                    "size": { "type": "string" } },
                    "required": ["prompt"] }),
            Risk::Write,
            false,
        );
        // A billed call that can take minutes: it runs as a background job, so the turn's tool
        // deadline never cuts off an image already paid for.
        ToolDef {
            background: true,
            ..def
        }
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let engine = self.0.get();
        let conversation = conversation(key).to_owned();
        Box::pin(async move {
            let args: ImageArgs = match parse(arguments) {
                Ok(args) => args,
                Err(output) => return output,
            };
            let Some(engine) = engine else {
                return ToolOutput::error("Spade is stopping.");
            };
            let Some(model) = image_model(&engine, &conversation) else {
                return ToolOutput::error("None of the person's models makes images now.");
            };
            let size = args
                .size
                .as_deref()
                .filter(|s| s.len() <= 16 && s.chars().all(|c| c.is_ascii_alphanumeric()));
            if !engine.can_spend().unwrap_or(false) {
                return ToolOutput::error("Today's spending cap is used up, so no image was made.");
            }
            let made = match engine
                .models()
                .generate_image(&model, &args.prompt, size)
                .await
            {
                Ok(made) => made,
                Err(error) => return ToolOutput::maybe_ran(error.to_string()),
            };
            engine.pay_call(&conversation, &model, &made.usage);
            let images = made.value;
            let mut shared = Shared::default();
            for bytes in images.iter().take(crate::images::MOST_IMAGES) {
                match engine.image_store().put(bytes) {
                    Ok(image) => shared.images.push(image),
                    Err(error) => {
                        return ToolOutput::error(format!("The image could not be kept: {error}"));
                    }
                }
            }
            let count = shared.images.len();
            ToolOutput {
                shared,
                ..ToolOutput::ok(format!(
                    "Shown to the person: {count} image{} made by {model}.",
                    if count == 1 { "" } else { "s" }
                ))
            }
        })
    }
}

/// The bot's own model when it makes images, else the first one on the person's endpoints that
/// does.
fn image_model(engine: &crate::engine::Engine, conversation: &str) -> Option<String> {
    let models = engine.models();
    let own = engine.reply_model(conversation);
    let can = |reference: &str| {
        models.resolve(reference).is_some_and(|(_, model)| {
            model.can(Capability::ImageGeneration) || model.can(Capability::ImageOutput)
        })
    };
    if can(&own) {
        return Some(own);
    }
    models
        .first_with(Capability::ImageGeneration)
        .or_else(|| models.first_with(Capability::ImageOutput))
}
