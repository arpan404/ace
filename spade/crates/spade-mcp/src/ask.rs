//! A server asking the person mid-call (MCP elicitation, form mode), and what Spade answers to a
//! server that asks to borrow the person's model (sampling: always refused, ADR 0202 §2).
//!
//! A call made with an [`Asker`] declares form elicitation to the server; the asker shows the
//! form to the person and gives back their reply. Only a form the server sends while that call
//! is in flight reaches it, and the call's timeout doesn't run while the person is deciding.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use serde_json::{Map, Value};

/// A form the server asks the person to fill in, as it sent it.
#[derive(Debug, Clone, PartialEq)]
pub struct Form {
    /// Why it asks, in the server's words.
    pub message: String,
    /// The `requestedSchema`: a flat object of primitive fields.
    pub schema: Value,
}

/// The person's reply to a [`Form`].
#[derive(Debug, Clone, PartialEq)]
pub enum Reply {
    /// They filled it in: the content, by field name.
    Accept(Map<String, Value>),
    /// They refused.
    Decline,
    /// They dismissed it without choosing, or it couldn't be shown.
    Cancel,
}

pub type AskFuture = Pin<Box<dyn Future<Output = Reply> + Send>>;

/// Shows a server's form to the person for one call and waits for their reply.
pub trait Asker: Send + Sync {
    fn ask(&self, form: Form) -> AskFuture;
}

/// The longest Spade waits for the person on one form; then the server reads `cancel`.
pub const MOST_WAIT: Duration = Duration::from_secs(15 * 60);

/// What a server that asks to sample the person's model is told.
pub const SAMPLING_REFUSED: &str =
    "Spade doesn't lend the person's model to apps: sampling is refused.";

/// The `elicitation/create` answer for `reply`.
pub(crate) fn result(reply: Reply) -> rmcp::model::ElicitResult {
    use rmcp::model::{ElicitResult, ElicitationAction};
    match reply {
        Reply::Accept(content) => {
            ElicitResult::new(ElicitationAction::Accept).with_content(Value::Object(content))
        }
        Reply::Decline => ElicitResult::new(ElicitationAction::Decline),
        Reply::Cancel => ElicitResult::new(ElicitationAction::Cancel),
    }
}
