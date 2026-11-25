//! Accounts that sign in instead of using a key (ADR 0214): a ChatGPT account Spade signs in to
//! itself. A finished sign-in becomes an account (an endpoint on the ChatGPT backend, id
//! `chatgpt`, `chatgpt-2`, …) or renews the one already added for that ChatGPT account. Tokens are
//! `spade_chatgpt`'s, in the keychain only; the database keeps the account's email, plan and id.

use std::collections::HashSet;
use std::sync::{Arc, Weak};

use spade_chatgpt::{BearerError, FlowView, Flows, Method, SignedIn};
use spade_models::{Bearers, Credential, DispatchGuard};
use spade_store::{StoreError, StoredEndpoint, StoredModel, StoredSignIn};

use super::{EndpointError, EndpointView, Engine};

/// The sign-in kind of a ChatGPT account.
pub(crate) const CHATGPT: &str = "chatgpt";

/// The provider a ChatGPT account belongs to.
pub(crate) const OPENAI: &str = "openai";

/// The most models saved from a new account's own list.
const MOST_SAVED: usize = 50;

fn invalid(text: &str) -> EndpointError {
    EndpointError::Invalid(text.to_owned())
}

impl Engine {
    /// Sets the sign-ins, and hands the model client the accounts' tokens. Once; later calls are
    /// ignored. A refresh OpenAI refuses marks the account signed out.
    pub fn set_sign_ins(self: &Arc<Self>, flows: Arc<Flows>) {
        if self.sign_ins.set(flows.clone()).is_err() {
            return;
        }
        // What a restored or copied home says is signed in is checked against what it really
        // keeps, off the async workers (the keychain may prompt).
        let checking = Arc::clone(self);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn_blocking(move || checking.reconcile_sign_ins());
        }
        let engine: Weak<Self> = Arc::downgrade(self);
        let accounts = flows.accounts().clone();
        let backend = accounts.config().backend.clone();
        // A refused refresh signs the account out, here as in Settings.
        let answer =
            move |engine: Weak<Self>,
                  id: String,
                  got: Result<spade_chatgpt::Bearer, BearerError>| match got {
                Ok(bearer) => Ok(Credential {
                    token: bearer.token,
                    generation: bearer.generation,
                }),
                Err(BearerError::SignedOut(line, generation)) => {
                    if let Some(engine) = engine.upgrade() {
                        let _ = engine.record_signed_out(&id, generation);
                    }
                    Err(line)
                }
                Err(BearerError::Failed(line)) => Err(line),
            };
        let (find_engine, find_accounts) = (engine.clone(), accounts.clone());
        let current_accounts = accounts.clone();
        self.models.set_bearers(Bearers::new(
            backend,
            move |id| {
                let (engine, accounts) = (find_engine.clone(), find_accounts.clone());
                Box::pin(async move {
                    let got = accounts.current_bearer(&id).await;
                    answer(engine, id, got)
                })
            },
            move |id, rejected: Credential| {
                let (engine, accounts) = (engine.clone(), accounts.clone());
                Box::pin(async move {
                    let got = accounts
                        .bearer_after_rejection(&id, &rejected.token, rejected.generation)
                        .await;
                    answer(engine, id, got)
                })
            },
            move |id, generation| {
                let accounts = current_accounts.clone();
                Box::pin(async move {
                    accounts
                        .dispatching(&id, generation)
                        .await
                        .map(|leave| Box::new(leave) as DispatchGuard)
                        .map_err(|e| e.to_string())
                })
            },
        ));
    }

    /// Starts a ChatGPT sign-in: a new account, or `account` signed back in. Refused unless the
    /// person has read that it may go against OpenAI's terms.
    pub async fn start_chatgpt_sign_in(
        self: &Arc<Self>,
        method: &str,
        terms_read: bool,
        account: Option<String>,
    ) -> Result<FlowView, EndpointError> {
        if !terms_read {
            return Err(invalid(
                "using a ChatGPT sign-in outside OpenAI's own Codex apps may go against OpenAI's \
                 terms; show the person that and send terms_read: true",
            ));
        }
        let method =
            Method::parse(method).ok_or_else(|| invalid("method must be browser or device"))?;
        let flows = self
            .sign_ins
            .get()
            .ok_or_else(|| invalid("this Spade cannot sign in to ChatGPT"))?
            .clone();
        if let Some(id) = &account {
            let stored = self.stored_endpoint(id)?;
            if stored.sign_in.as_ref().is_none_or(|s| s.kind != CHATGPT) {
                return Err(invalid("that account does not sign in to ChatGPT"));
            }
        }
        let engine = Arc::downgrade(self);
        let finish: spade_chatgpt::Finish = Arc::new(move |done: SignedIn| {
            let (engine, wanted) = (engine.clone(), account.clone());
            Box::pin(async move {
                let Some(engine) = engine.upgrade() else {
                    return Err("Spade is stopping".to_owned());
                };
                engine.keep_sign_in(wanted, done).await
            })
        });
        flows.start(method, finish).await.map_err(|line| {
            if line.contains("in use") {
                EndpointError::Conflict(line)
            } else {
                EndpointError::Invalid(line)
            }
        })
    }

    /// The sign-ins this Spade can run.
    pub fn sign_in_kinds(&self) -> Vec<&'static str> {
        if self.sign_ins.get().is_some() {
            vec![CHATGPT]
        } else {
            Vec::new()
        }
    }

    /// The provider an account belongs to: the preset it was made from, OpenAI for a ChatGPT
    /// sign-in, or none for one added by address.
    pub fn provider_of(stored: &StoredEndpoint) -> Option<&str> {
        match &stored.sign_in {
            Some(s) if s.kind == CHATGPT => Some(OPENAI),
            _ => stored.preset.as_deref(),
        }
    }

    /// Whether account `id` signs in (a ChatGPT account) rather than using a key.
    pub fn signs_in(&self, id: &str) -> bool {
        self.stored_endpoint(id).is_ok_and(|e| e.sign_in.is_some())
    }

    /// Names of the bots whose model is on account `id`.
    pub fn bots_on(&self, id: &str) -> Vec<String> {
        self.store.agents_using_endpoint(id).unwrap_or_default()
    }

    /// A sign-in as it stands.
    pub fn chatgpt_sign_in(&self, flow: &str) -> Option<FlowView> {
        self.sign_ins.get()?.view(flow)
    }

    /// Cancels a waiting sign-in. Returns whether it was waiting.
    pub fn cancel_chatgpt_sign_in(&self, flow: &str) -> bool {
        self.sign_ins.get().is_some_and(|f| f.cancel(flow))
    }

    /// Signs an account out: its tokens leave the keychain; the account and its bots stay.
    pub async fn sign_out(&self, id: &str) -> Result<EndpointView, EndpointError> {
        let stored = self.stored_endpoint(id)?;
        if stored.sign_in.is_none() {
            return Err(invalid("that account uses a key; remove its key instead"));
        }
        match self.sign_ins.get() {
            Some(flows) => {
                let generation = flows
                    .accounts()
                    .sign_out(id)
                    .await
                    .map_err(|e| EndpointError::Keychain(e.to_string()))?;
                self.record_signed_out(id, generation)?;
            }
            None => {
                self.forget_sign_in(id)?;
            }
        }
        self.endpoint_views()?
            .into_iter()
            .find(|v| v.stored.id == id)
            .ok_or(EndpointError::NotFound)
    }

    /// Removes a deleted account's sign-in tokens, before its row and its id go: from memory and
    /// the keychain, under the account's own lock, so a refresh or sign-in under way finishes
    /// first and can't write them back. Blocking code only (it waits on that lock).
    pub(super) fn forget_sign_in(&self, id: &str) -> Result<(), EndpointError> {
        let forgot = match self.sign_ins.get() {
            Some(flows) => flows.accounts().forget_now(id).map_err(|e| e.to_string()),
            None => match &self.keychain {
                Some(keychain) => keychain.delete_sign_in_key(id).map_err(|e| e.to_string()),
                None => Ok(false),
            },
        };
        forgot.map(|_| ()).map_err(EndpointError::Keychain)
    }

    fn stored_endpoint(&self, id: &str) -> Result<StoredEndpoint, EndpointError> {
        self.store
            .endpoints()?
            .into_iter()
            .find(|e| e.id == id)
            .ok_or(EndpointError::NotFound)
    }

    /// Records that an account is signed out, as of credential `generation`: only while that is
    /// still its generation, so a sign-in that came since is never marked signed out.
    pub fn record_signed_out(&self, id: &str, generation: u64) -> Result<(), StoreError> {
        let _endpoints = self.endpoint_lock.lock().unwrap_or_else(|p| p.into_inner());
        let current = self
            .sign_ins
            .get()
            .is_none_or(|flows| flows.accounts().is_current(id, generation));
        if !current {
            return Ok(());
        }
        let Some(mut stored) = self.store.endpoints()?.into_iter().find(|e| e.id == id) else {
            return Ok(());
        };
        let Some(sign_in) = stored.sign_in.as_mut().filter(|s| s.signed_in) else {
            return Ok(());
        };
        sign_in.signed_in = false;
        self.store.update_endpoint(&stored)?;
        Ok(())
    }

    /// Marks signed out every account the database says is signed in but whose sign-in isn't
    /// whole where it rests (no key, no sealed file): a home restored to another machine, say.
    /// Blocking: reads the keychain.
    pub fn reconcile_sign_ins(&self) {
        let Some(flows) = self.sign_ins.get() else {
            return;
        };
        let accounts = flows.accounts();
        for row in self.store.endpoints().unwrap_or_default() {
            if !row.sign_in.as_ref().is_some_and(|s| s.signed_in) {
                continue;
            }
            let generation = accounts.generation(&row.id);
            if let Ok(false) = accounts.kept_whole(&row.id) {
                let _ = self.record_signed_out(&row.id, generation);
            }
        }
    }

    /// Accounts that sign in but are signed out now: never picked as a default.
    pub(super) fn signed_out(&self) -> HashSet<String> {
        self.store
            .endpoints()
            .unwrap_or_default()
            .into_iter()
            .filter(|e| e.sign_in.as_ref().is_some_and(|s| !s.signed_in))
            .map(|e| e.id)
            .collect()
    }

    /// Keeps a finished sign-in: renews the account already added for this ChatGPT account (or
    /// the one being signed back in), else adds one. Its id, or why not in one line. One at a
    /// time; a new account's row (its id) is taken before its tokens are written, so no other
    /// account's tokens are ever replaced or erased.
    async fn keep_sign_in(&self, wanted: Option<String>, done: SignedIn) -> Result<String, String> {
        let flows = self
            .sign_ins
            .get()
            .ok_or("this Spade cannot sign in to ChatGPT")?
            .clone();
        let _keeping = flows.keeping().await;
        let accounts = flows.accounts().clone();
        let facts = StoredSignIn {
            kind: CHATGPT.to_owned(),
            account_id: done.account.account_id.clone(),
            email: done.account.email.clone(),
            plan: done.account.plan.clone(),
            signed_in: true,
        };
        let (id, added) = self.reserve_sign_in(wanted.as_deref(), &done, &accounts)?;
        // From here to the commit below, this sign-in holds its reservation: the row under an
        // id no other account ever had or will have, so whatever happens to it, the cleanup
        // touches only what this sign-in made.
        let generation = match accounts.keep(&id, &done.tokens).await {
            Ok(generation) => generation,
            Err(error) => {
                // A new account's reservation goes with whatever it wrote (one entry: all or
                // nothing); an account being renewed keeps the tokens it had.
                if added {
                    let _ = accounts.forget(&id).await;
                    let _endpoints = self.endpoint_lock.lock().unwrap_or_else(|p| p.into_inner());
                    let _ = self.store.delete_endpoint(&id, self.now_ms());
                    let _ = self.sync_endpoints();
                }
                return Err(error.to_string());
            }
        };
        flows.after_keep(&id).await;
        // Committed only while these tokens are still the account's: a sign-out or removal that
        // came in between wins, and the account is never shown signed in without them.
        enum Commit {
            Saved { empty: bool },
            SignedOut,
            Removed,
        }
        let committed = {
            let _endpoints = self.endpoint_lock.lock().unwrap_or_else(|p| p.into_inner());
            let row = self
                .store
                .endpoints()
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|e| e.id == id)
                .filter(|_| !self.retiring(&id));
            match row {
                Some(_) if !accounts.is_current(&id, generation) => Commit::SignedOut,
                Some(mut row) => {
                    let empty = row.models.is_empty();
                    row.sign_in = Some(facts);
                    self.store
                        .update_endpoint(&row)
                        .map_err(|e| e.to_string())?;
                    self.sync_endpoints().map_err(|e| e.to_string())?;
                    Commit::Saved { empty }
                }
                None => Commit::Removed,
            }
        };
        let empty = match committed {
            Commit::Saved { empty } => empty,
            Commit::SignedOut => {
                return Err("the account was signed out while signing in".to_owned());
            }
            Commit::Removed => {
                // Removed while it signed in: the tokens just kept go too.
                let _ = accounts.forget(&id).await;
                return Err("the account was removed while signing in".to_owned());
            }
        };
        if added || empty {
            match self.save_listed_models(&id, generation).await {
                Listed::Done => {}
                Listed::Unreadable(why) => {
                    tracing::warn!(
                        endpoint = %id,
                        why,
                        "an account's own model list could not be read; its sign-in stands"
                    );
                }
                Listed::SignedOut => {
                    return Err("the account was signed out while signing in".to_owned());
                }
            }
        }
        Ok(id)
    }

    /// The account a finished sign-in goes to, and whether it is new: the one being signed back
    /// in, the one already added for this ChatGPT account, else a new row, signed out until its
    /// tokens are kept, under a free id taken now.
    fn reserve_sign_in(
        &self,
        wanted: Option<&str>,
        done: &SignedIn,
        accounts: &spade_chatgpt::Accounts,
    ) -> Result<(String, bool), String> {
        let _endpoints = self.endpoint_lock.lock().unwrap_or_else(|p| p.into_inner());
        let endpoints = self.store.endpoints().map_err(|e| e.to_string())?;
        let same = |e: &StoredEndpoint| {
            e.sign_in
                .as_ref()
                .is_some_and(|s| s.kind == CHATGPT && s.account_id == done.account.account_id)
        };
        if let Some(id) = wanted {
            let row = endpoints
                .iter()
                .find(|e| e.id == id && !self.retiring(id))
                .ok_or("the account was removed while signing in")?;
            if !same(row) {
                let who = done.account.email.as_deref().unwrap_or("another account");
                return Err(format!(
                    "you signed in as {who}, not as {}; add it as a new account instead",
                    row.name
                ));
            }
            return Ok((row.id.clone(), false));
        }
        if let Some(row) = endpoints.iter().find(|e| same(e) && !self.retiring(&e.id)) {
            return Ok((row.id.clone(), false));
        }
        let id = self.fresh_sign_in_id(&endpoints)?;
        // Named for the provider, never the email: the name shows to every caller, the email only
        // to the person.
        let name = sign_in_name(&endpoints);
        let row = StoredEndpoint {
            gateway_token: false,
            id: id.clone(),
            name,
            format: spade_models::Format::OpenAiResponses.name().to_owned(),
            base_url: accounts.config().backend.clone(),
            headers: Vec::new(),
            session_header: None,
            needs_key: false,
            key_env: None,
            preset: None,
            created_ms: self.now_ms(),
            sign_in: Some(StoredSignIn {
                kind: CHATGPT.to_owned(),
                account_id: done.account.account_id.clone(),
                email: done.account.email.clone(),
                plan: done.account.plan.clone(),
                signed_in: false,
            }),
            models: Vec::new(),
        };
        self.store
            .insert_endpoint(&row)
            .map_err(|e| e.to_string())?;
        self.sync_endpoints().map_err(|e| e.to_string())?;
        Ok((id, true))
    }

    /// Saves the models a new or empty account lists for itself, so it starts with what it may
    /// use. The list is read without `endpoint_lock`; it lands only while the account is still
    /// there, still signed in under the credential this sign-in kept, and still without a model
    /// saved, and then all at once: a model the person saved while the list was in flight is
    /// never replaced by it. A list that can't be read leaves the account as it was, and the
    /// sign-in stands unless the account was signed out meanwhile.
    async fn save_listed_models(&self, id: &str, generation: u64) -> Listed {
        let listed = self.list_endpoint_models(id).await;
        let accounts = self.sign_ins.get().map(|flows| flows.accounts().clone());
        // Rechecked only now the reading is over: a sign-out, a removal or another sign-in while
        // it was in flight wins over this list.
        let still = {
            let _endpoints = self.endpoint_lock.lock().unwrap_or_else(|p| p.into_inner());
            match self.store.endpoints() {
                Err(error) => return Listed::Unreadable(error.to_string()),
                Ok(all) => match all.into_iter().find(|e| e.id == id) {
                    None => Still::Gone,
                    Some(row)
                        if !row.sign_in.as_ref().is_some_and(|s| s.signed_in)
                            || accounts.is_some_and(|a| !a.is_current(id, generation)) =>
                    {
                        Still::SignedOut
                    }
                    Some(row) if !row.models.is_empty() => Still::Saved,
                    Some(_) => Still::Empty,
                },
            }
        };
        let listed = match listed {
            Ok(listed) => listed,
            Err(error) => {
                return match still {
                    Still::SignedOut => Listed::SignedOut,
                    // The list, not the sign-in, is what failed: the person can list again.
                    _ => Listed::Unreadable(error.to_string()),
                };
            }
        };
        match still {
            Still::SignedOut => Listed::SignedOut,
            Still::Gone | Still::Saved => Listed::Done,
            Still::Empty => {
                let saved: Vec<StoredModel> = listed
                    .into_iter()
                    .take(MOST_SAVED)
                    .map(|model| StoredModel {
                        id: model.id,
                        name: model.name,
                        context: model.context,
                        capabilities: model
                            .capabilities
                            .map(|c| c.iter().map(|c| c.name().to_owned()).collect()),
                        source: "listed".to_owned(),
                    })
                    .collect();
                match self.save_once_empty(id, &saved) {
                    Ok(()) => Listed::Done,
                    Err(error) => Listed::Unreadable(error),
                }
            }
        }
    }

    /// Saves `models` on an account that still has none, under the lock that keeps a save of the
    /// person's out: one made in between is the one that stays.
    fn save_once_empty(&self, id: &str, models: &[StoredModel]) -> Result<(), String> {
        let _endpoints = self.endpoint_lock.lock().unwrap_or_else(|p| p.into_inner());
        match self.store.put_listed_models(id, models) {
            Ok(true) => {
                self.sync_endpoints().map_err(|e| e.to_string())?;
                Ok(())
            }
            // Taken by a save on another connection, or the account went: either way the
            // person's list is the one that stays.
            Ok(false) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }

    /// A new account's id: `chatgpt-<16 characters>`, never one any endpoint has or ever had
    /// (removed ids are retired for good), so a sign-in, its tokens and every call on it name
    /// one account only.
    fn fresh_sign_in_id(&self, endpoints: &[StoredEndpoint]) -> Result<String, String> {
        let taken: HashSet<&str> = endpoints.iter().map(|e| e.id.as_str()).collect();
        for _ in 0..16 {
            let unique = self.ids.next("");
            let tail: String = unique
                .chars()
                .filter(char::is_ascii_alphanumeric)
                .collect::<String>()
                .to_ascii_lowercase();
            // Sixteen random characters: unique across every Spade home on the machine, since
            // a sign-in's key in the keychain is filed by this id alone.
            let short = &tail[tail.len().saturating_sub(16)..];
            let id = format!("{CHATGPT}-{short}");
            let retired = self
                .store
                .endpoint_retired(&id)
                .map_err(|e| e.to_string())?;
            if !taken.contains(id.as_str()) && !retired && !self.retiring(&id) {
                return Ok(id);
            }
        }
        Err("no free account id; try again".to_owned())
    }
}

/// What became of a new or empty account's own model list.
enum Listed {
    /// Saved, or nothing to save (the person saved a model meanwhile, or the account went).
    Done,
    /// The list could not be read this time: the sign-in stands, and the person can list again.
    Unreadable(String),
    /// The account was signed out while the list was read: the sign-in did not hold.
    SignedOut,
}

/// Where an account stood once its own model list was read.
enum Still {
    /// Gone while the list was read.
    Gone,
    /// Signed out, or signed in again under another credential, while the list was read.
    SignedOut,
    /// A model saved meanwhile: the list must not touch it.
    Saved,
    /// Still there, still signed in, still with no model saved: the list may land.
    Empty,
}

/// A new ChatGPT account's name: `ChatGPT`, else `ChatGPT 2` and on, the first not shown already.
fn sign_in_name(endpoints: &[StoredEndpoint]) -> String {
    let names: HashSet<&str> = endpoints.iter().map(|e| e.name.as_str()).collect();
    (1..)
        .map(|n| {
            if n == 1 {
                "ChatGPT".to_owned()
            } else {
                format!("ChatGPT {n}")
            }
        })
        .find(|name| !names.contains(name.as_str()))
        .unwrap_or_else(|| "ChatGPT".to_owned())
}
