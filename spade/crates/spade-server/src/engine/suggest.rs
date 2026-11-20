//! A bot suggesting a package (ADR 0200 §8, §10 phase 2): `package_suggest {package, why}` makes
//! a suggest card, a question card of kind `suggest` (ADR 0154), from the market's signed version
//! manifest and the `bot.json` it covers, read through ace's marketplace and checked here with the
//! market keys this build trusts. A name the market doesn't list, or a listing whose signature
//! doesn't verify, is refused to the bot. Only the person installs, through the normal install
//! review; once a bot made from that package exists, Spade answers every open card for it, and
//! the turn carries on. A bot has no way to install anything.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use spade_core::event::{Call, Event, Known};
use spade_core::question::suggest::{self, Installed, Publisher, Suggest};
use spade_core::question::{self, Standing};

use super::apps::Requested;
use super::Engine;
use crate::packages::envelope::{self, Envelope, MARKET};
use crate::tools::ToolOutput;

/// What a market lookup answers.
pub type MarketFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Option<Envelope>, String>> + Send + 'a>>;

/// The market as Spade reads it for suggestions: through ace's marketplace while ace is there.
pub trait MarketBots: Send + Sync {
    /// The version of the bot package `name` the market lists now: its signed version manifest
    /// as served and `bot.json`'s exact text. `None` when the market lists no such package.
    fn listed_bot(&self, name: &str) -> MarketFuture<'_>;
}

/// Where suggest cards still open are found when a package is installed.
const OPEN: &str = "package_suggest:open";
/// The most open cards remembered; the oldest go first.
const MOST_OPEN: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Open {
    conversation: String,
    call_id: String,
    package: String,
}

impl Engine {
    /// Has Spade read the market through `market`.
    pub fn set_market(&self, market: Arc<dyn MarketBots>) {
        let _ = self.market.set(market);
    }

    /// `package_suggest {package, why}` from call `call` of reply `reply` in `id`.
    pub(super) async fn package_suggest(
        &self,
        id: &str,
        reply: &str,
        call: &Call,
        arguments: &Value,
    ) -> Result<Requested, String> {
        let answered = |text: String| Ok(Requested::Answered(ToolOutput::error(text)));
        let (package, why) = match suggest::parse(arguments) {
            Ok(asked) => asked,
            Err(why) => return answered(why),
        };
        if self
            .store
            .agent_for_conversation(id)
            .map_err(|e| e.to_string())?
            .is_none()
        {
            return answered("Only a bot can suggest a package.".to_owned());
        }
        let Some(market) = self.market.get() else {
            return answered(
                "Packages can't be suggested here: the market isn't reachable without ace."
                    .to_owned(),
            );
        };
        let sealed = match market.listed_bot(&package).await {
            Ok(Some(sealed)) => sealed,
            Ok(None) => return answered(unknown(&package)),
            Err(why) => {
                return answered(format!(
                    "The market can't be read now ({why}). Try again later, or carry on without \
                     it."
                ));
            }
        };
        let card = match self.suggest_card(&package, &sealed) {
            Ok(card) => card,
            Err(why) => return answered(why),
        };
        let summary = suggest::summary(&card, &why);
        let event = Event::Known(Known::QuestionAsked {
            reply: reply.to_owned(),
            call_id: call.id.clone(),
            question: summary,
            questions: vec![suggest::question(why, card)],
            later: false,
        });
        match self.record_all_unless_stopped(id, reply, &[event]) {
            Ok(true) => {
                self.remember_open(Open {
                    conversation: id.to_owned(),
                    call_id: call.id.clone(),
                    package,
                })
                .map_err(|e| e.to_string())?;
                Ok(Requested::Waiting)
            }
            Ok(false) => Ok(Requested::Stopped),
            Err(error) => Err(error.to_string()),
        }
    }

    /// The card for `package` from what the market served: believed only when the signature
    /// verifies with a trusted market key, covers these exact `bot.json` bytes and names this
    /// package. The publisher is the signed manifest's, never the listing's or the bot's.
    fn suggest_card(&self, package: &str, sealed: &Envelope) -> Result<Suggest, String> {
        let (id, recipe) = envelope::verify(sealed, &self.market_keys()).map_err(|why| {
            format!("{package}'s market listing can't be trusted ({why}), so it isn't suggested.")
        })?;
        if id.name != package {
            return Err(unknown(package));
        }
        let publisher: Publisher = serde_json::from_value(sealed.signed["body"]["publisher"].clone())
            .map_err(|_| format!("{package}'s signed listing names no publisher."))?;
        let manifest = crate::packages::manifest(&recipe)
            .map_err(|why| format!("{package} can't be installed on this Spade: {why}"))?;
        Ok(suggest::card(MARKET, package, &id.version, publisher, &manifest))
    }

    fn open_cards(&self) -> Result<Vec<Open>, spade_store::StoreError> {
        Ok(self
            .store
            .setting(OPEN)?
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default())
    }

    fn write_open(&self, open: &[Open]) -> Result<(), spade_store::StoreError> {
        let raw = serde_json::to_string(open).unwrap_or_else(|_| "[]".to_owned());
        self.store.set_setting(OPEN, Some(&raw))
    }

    fn remember_open(&self, card: Open) -> Result<(), spade_store::StoreError> {
        let _order = self.suggest_lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut open = self.open_cards()?;
        open.push(card);
        let extra = open.len().saturating_sub(MOST_OPEN);
        open.drain(..extra);
        self.write_open(&open)
    }

    /// The person installed the market package `package` as bot `bot` named `name`: every suggest
    /// card still open for it reads that as its answer. A card still waiting wakes its turn; one
    /// left for later is delivered like a late answer. Cards no longer open are forgotten.
    pub fn package_installed(self: &Arc<Self>, package: &str, bot: &str, name: &str) {
        let _order = self.suggest_lock.lock().unwrap_or_else(|p| p.into_inner());
        let open = match self.open_cards() {
            Ok(open) => open,
            Err(error) => {
                tracing::warn!(%error, "could not read the open package suggestions");
                return;
            }
        };
        let answer = Installed {
            bot: bot.to_owned(),
            name: name.to_owned(),
        }
        .answer();
        let mut kept = Vec::new();
        for card in open {
            let standing = self
                .load(&card.conversation)
                .ok()
                .and_then(|events| question::standing(events.iter(), &card.call_id));
            let Some(standing @ (Standing::Waiting | Standing::Deferred)) = standing else {
                continue;
            };
            if card.package != package {
                kept.push(card);
                continue;
            }
            let event = Event::Known(Known::QuestionAnswered {
                call_id: card.call_id.clone(),
                answers: vec![answer.clone()],
                late: standing == Standing::Deferred,
                typed: false,
            });
            if let Err(error) = self.land(&card.conversation, standing, event) {
                tracing::warn!(%error, "could not answer a package suggestion");
            }
        }
        if let Err(error) = self.write_open(&kept) {
            tracing::warn!(%error, "could not keep the open package suggestions");
        }
    }
}

/// What a bot reads when it named a package the market doesn't list.
fn unknown(package: &str) -> String {
    format!(
        "There's no package called {package} in the market. Only packages the market lists can \
         be suggested; don't guess a name."
    )
}
