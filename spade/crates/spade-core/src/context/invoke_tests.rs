//! A skill or command the person started rides at the tail of its own message in the prompt
//! (docs/design.md, Caching): what came before it never changes.

use spade_models::Message;

use super::*;
use crate::event::{Event, Invoked, Known};

fn invoking(text: &str, invoked: Invoked) -> Event {
    let Event::Known(Known::UserMessage {
        context,
        images,
        documents,
        ..
    }) = Event::user_message(text)
    else {
        unreachable!("a message")
    };
    Event::Known(Known::UserMessage {
        text: text.into(),
        context,
        images,
        documents,
        voice: None,
        from_agent: None,
        from_routine: None,
        from_group: None,
        from_thread: None,
        reply_to: None,
        invoke: Some(Box::new(invoked)),
    })
}

fn ship() -> Invoked {
    Invoked {
        kind: "command".into(),
        id: "plg_1".into(),
        name: "ship".into(),
        args: Some("v2.1".into()),
        text: "Ship v2.1 now.".into(),
    }
}

fn person_texts(events: &[Event]) -> Vec<String> {
    messages(events)
        .into_iter()
        .filter_map(|message| match message {
            Message::Person { text, .. } => Some(text),
            _ => None,
        })
        .collect()
}

#[test]
fn the_invoked_text_follows_the_message_it_started() {
    let texts = person_texts(&[invoking("v2.1", ship())]);
    assert_eq!(texts.len(), 1);
    let text = &texts[0];
    assert!(
        text.starts_with("[m1] v2.1\n\n<invoked kind=\"command\" name=\"ship\">"),
        "{text}"
    );
    assert!(text.ends_with("Ship v2.1 now.\n</invoked>"), "{text}");
}

#[test]
fn a_later_message_leaves_the_earlier_prompt_bytes_alone() {
    let mut events = vec![Event::user_message("Hello"), invoking("v2.1", ship())];
    let before = person_texts(&events).concat();
    events.push(Event::user_message("And then?"));
    let after = person_texts(&events).concat();
    assert!(after.starts_with(&before), "{after}");
    assert_eq!(after.matches("<invoked").count(), 1, "{after}");
}
