//! Asking a reviewer for its typed judgment (ADR 0135, 0163). A reasoning model can spend its
//! budget before the JSON ends, so an answer that comes back empty, cut short or unparseable is
//! asked for once more; both tries share one deadline. What failed goes to the logs, and the
//! person is told in a plain sentence ([`autonomy::undecided`]), never the raw error.

use std::sync::Arc;
use std::time::Duration;

use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use spade_core::autonomy;
use spade_models::Prompt;
use tokio::sync::watch;

use super::Engine;
use super::ledger::{likely_usage, prompt_tokens};

/// What asking the reviewer came to, with what every try cost.
pub(super) enum Judged<T> {
    Answer(T, u64),
    /// No judgment: the sentence the person is shown.
    Failed(&'static str, u64),
    TimedOut(u64),
    Stopped,
}

/// Asks `model` for a `T`, trying once more when its answer can't be read.
pub(super) async fn judge<T: JsonSchema + DeserializeOwned>(
    engine: &Arc<Engine>,
    id: &str,
    model: &str,
    prompt: &Prompt,
    timeout: Duration,
    stop: &mut watch::Receiver<bool>,
) -> Judged<T> {
    let deadline = tokio::time::Instant::now() + timeout;
    // A call cut off before its usage came is still paid for: at least its prompt.
    let estimate = || likely_usage(prompt_tokens(prompt), Default::default(), 0);
    let mut cost = 0;
    let mut tries = 0;
    loop {
        tries += 1;
        let admitted = engine
            .admit(id, model)
            .for_role(spade_core::routing::Role::Review);
        let asked = tokio::select! {
            answer = tokio::time::timeout_at(
                deadline,
                engine.models.generate::<T>(model, prompt),
            ) => Some(answer),
            _ = stop.wait_for(|stopped| *stopped) => None,
        };
        let error = match asked {
            None => {
                admitted.settle(&estimate());
                return Judged::Stopped;
            }
            Some(Err(_)) => return Judged::TimedOut(cost + admitted.settle(&estimate())),
            Some(Ok(Ok(generated))) => {
                cost += admitted.settle(&generated.usage);
                return Judged::Answer(generated.value, cost);
            }
            Some(Ok(Err(error))) => error,
        };
        cost += match error.usage() {
            Some(usage) => admitted.settle(&usage),
            None if error.may_have_billed() => admitted.settle(&estimate()),
            None => admitted.settle_if(None),
        };
        let again = tries == 1 && autonomy::answer_again(&error);
        tracing::warn!(%error, conversation = id, tries, again, "the reviewer gave no judgment");
        if !again {
            return Judged::Failed(autonomy::undecided(&error), cost);
        }
    }
}
