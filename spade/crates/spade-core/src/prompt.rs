//! Builds the prompt for a reply from the transcript, within a size budget.

use spade_models::Prompt;

use crate::transcript::{Outcome, Speaker, Transcript};

/// Spade's standing instructions.
pub const SYSTEM: &str = "You are Spade, the assistant built into ace. Answer clearly and directly. \
Use Markdown when it helps: lists, tables and fenced code. Say so when you are unsure, and never \
claim to have done something you did not do.";

/// The prompt for the next reply: `system`, then the conversation, newest kept first when it does
/// not fit in `budget_chars`. The reply being written (still answering) is left out. Consecutive
/// messages from the same speaker are joined, and the conversation always starts with the person,
/// as every provider accepts that shape.
pub fn build(system: &str, transcript: &Transcript, budget_chars: usize) -> Prompt {
    let mut turns: Vec<(Speaker, String)> = Vec::new();
    for message in &transcript.messages {
        if message.outcome == Outcome::Answering || message.text.trim().is_empty() {
            continue;
        }
        match turns.last_mut() {
            Some((speaker, text)) if *speaker == message.speaker => {
                text.push_str("\n\n");
                text.push_str(&message.text);
            }
            _ => turns.push((message.speaker, message.text.clone())),
        }
    }
    let mut size: usize = turns.iter().map(|(_, text)| text.len()).sum();
    while turns.len() > 1 && size > budget_chars {
        let (_, dropped) = turns.remove(0);
        size -= dropped.len();
    }
    while matches!(turns.first(), Some((Speaker::Spade, _))) {
        turns.remove(0);
    }
    let mut prompt = Prompt::default().system(system);
    for (speaker, text) in turns {
        prompt = match speaker {
            Speaker::Person => prompt.person(text),
            Speaker::Spade => prompt.spade(text),
        };
    }
    prompt
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{Event, Known};
    use spade_models::{Message, Speaker as PromptSpeaker};

    fn finished(reply: &str, text: &str) -> Event {
        Event::Known(Known::ReplyFinished {
            reply: reply.into(),
            text: text.into(),
            input_tokens: None,
            output_tokens: None,
            cost_micros: 0,
        })
    }

    fn turns(prompt: &Prompt) -> Vec<(PromptSpeaker, &str)> {
        prompt
            .messages
            .iter()
            .map(|Message { speaker, text }| (*speaker, text.as_str()))
            .collect()
    }

    #[test]
    fn the_conversation_is_sent_in_order_without_the_reply_being_written() {
        let events = [
            Event::user_message("Hi"),
            Event::reply_started("r1", "m"),
            finished("r1", "Hello!"),
            Event::user_message("How are you?"),
            Event::reply_started("r2", "m"),
        ];
        let prompt = build(SYSTEM, &Transcript::fold(&events), 10_000);
        assert_eq!(prompt.system.as_deref(), Some(SYSTEM));
        assert_eq!(
            turns(&prompt),
            vec![
                (PromptSpeaker::Person, "Hi"),
                (PromptSpeaker::Spade, "Hello!"),
                (PromptSpeaker::Person, "How are you?"),
            ]
        );
    }

    #[test]
    fn messages_after_an_empty_failed_reply_are_joined() {
        let events = [
            Event::user_message("First"),
            Event::reply_started("r1", "m"),
            Event::Known(Known::ReplyFailed {
                reply: "r1".into(),
                text: String::new(),
                error: "down".into(),
            }),
            Event::user_message("Again"),
        ];
        let prompt = build(SYSTEM, &Transcript::fold(&events), 10_000);
        assert_eq!(
            turns(&prompt),
            vec![(PromptSpeaker::Person, "First\n\nAgain")]
        );
    }

    #[test]
    fn the_oldest_turns_go_first_when_over_budget_and_the_start_is_the_person() {
        let events = [
            Event::user_message("old question"),
            Event::reply_started("r1", "m"),
            finished("r1", "old answer"),
            Event::user_message("new question"),
        ];
        let prompt = build(SYSTEM, &Transcript::fold(&events), 20);
        assert_eq!(
            turns(&prompt),
            vec![(PromptSpeaker::Person, "new question")]
        );
    }

    #[test]
    fn the_latest_message_is_kept_even_when_it_alone_is_over_budget() {
        let events = [Event::user_message("a very long message")];
        let prompt = build(SYSTEM, &Transcript::fold(&events), 3);
        assert_eq!(
            turns(&prompt),
            vec![(PromptSpeaker::Person, "a very long message")]
        );
    }
}
