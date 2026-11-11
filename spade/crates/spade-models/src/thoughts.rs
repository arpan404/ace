//! Converts a model's thinking between the SDK's content parts and Spade's [`Thought`]s, keeping
//! order and every byte, so it goes back exactly as it came.

use genai::chat::{ContentPart, CustomPart, MessageContent};

use crate::prompt::Thought;

/// The thoughts in a reply's content, in order. `reasoning` is reasoning the SDK reported apart
/// from the content (OpenAI-compatible `reasoning_content`); it is kept when no thought already
/// carries reasoning text.
pub(crate) fn read(content: Option<&MessageContent>, reasoning: Option<&str>) -> Vec<Thought> {
    let mut out: Vec<Thought> = Vec::new();
    for part in content.map(MessageContent::parts).into_iter().flatten() {
        match part {
            ContentPart::ThoughtSignature(signature) => out.push(Thought::Signed {
                signature: signature.clone(),
                reasoning: None,
            }),
            ContentPart::ReasoningContent(text) => match out.last_mut() {
                Some(Thought::Signed {
                    reasoning: slot @ None,
                    ..
                }) => *slot = Some(text.clone()),
                _ => out.push(Thought::Reasoning { text: text.clone() }),
            },
            ContentPart::Custom(custom) if is_thinking(custom) => out.push(Thought::Block {
                data: custom.data.clone(),
            }),
            _ => {}
        }
    }
    let has_reasoning = out.iter().any(|t| match t {
        Thought::Signed { reasoning, .. } => reasoning.is_some(),
        Thought::Reasoning { .. } => true,
        Thought::Block { .. } => false,
    });
    if !has_reasoning && let Some(text) = reasoning.filter(|r| !r.is_empty()) {
        out.insert(
            0,
            Thought::Reasoning {
                text: text.to_owned(),
            },
        );
    }
    out
}

/// The parts that send `thoughts` back, in order, ahead of the turn's text and calls.
pub(crate) fn parts(thoughts: &[Thought]) -> Vec<ContentPart> {
    let mut out = Vec::new();
    for thought in thoughts {
        match thought {
            Thought::Signed {
                signature,
                reasoning,
            } => {
                out.push(ContentPart::ThoughtSignature(signature.clone()));
                if let Some(reasoning) = reasoning {
                    out.push(ContentPart::ReasoningContent(reasoning.clone()));
                }
            }
            Thought::Reasoning { text } => out.push(ContentPart::ReasoningContent(text.clone())),
            Thought::Block { data } => out.push(ContentPart::Custom(CustomPart {
                model_iden: None,
                data: data.clone(),
            })),
        }
    }
    out
}

fn is_thinking(custom: &CustomPart) -> bool {
    matches!(custom.typ(), Some("thinking" | "redacted_thinking"))
}
