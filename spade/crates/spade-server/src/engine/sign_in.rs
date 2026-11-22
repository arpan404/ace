//! Accounts that sign in instead of using a key (ADR 0214): a ChatGPT account Spade signs in to
//! itself. A finished sign-in becomes an account (an endpoint on the ChatGPT backend, id
//! `chatgpt`, `chatgpt-2`, …) or renews the one already added for that ChatGPT account. Tokens are
//! `spade_chatgpt`'s, in the keychain only; the database keeps the account's email, plan and id.

use std::collections::HashSet;
use std::sync::{Arc, Weak};

use spade_chatgpt::{BearerError, FlowView, Flows, Method, SignedIn};
use spade_models::Bearers;
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
        let engine: Weak<Self> = Arc::downgrade(self);
        let accounts = flows.accounts().clone();
        let backend = accounts.config().backend.clone();
        // A refused refresh signs the account out, here as in Settings.
        let answer =
            move |engine: Weak<Self>, id: String, got: Result<String, BearerError>| match got {
                Ok(token) => Ok(token),
                Err(BearerError::SignedOut(line)) => {
                    if let Some(engine) = engine.upgrade() {
                        let _ = engine.mark_signed_in(&id, false);
                    }
                    Err(line)
                }
                Err(BearerError::Failed(line)) => Err(line),
            };
        let (find_engine, find_accounts) = (engine.clone(), accounts.clone());
        self.models.set_bearers(Bearers::new(
            backend,
            move |id| {
                let (engine, accounts) = (find_engine.clone(), find_accounts.clone());
                Box::pin(async move {
                    let got = accounts.bearer(&id).await;
                    answer(engine, id, got)
                })
            },
            move |id, rejected| {
                let (engine, accounts) = (engine.clone(), accounts.clone());
                Box::pin(async move {
                    let got = accounts.bearer_after_rejection(&id, &rejected).await;
                    answer(engine, id, got)
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
        if let Some(flows) = self.sign_ins.get() {
            flows
                .accounts()
                .forget(id)
                .await
                .map_err(|e| EndpointError::Keychain(e.to_string()))?;
        }
        self.mark_signed_in(id, false)?;
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
                Some(keychain) => keychain.delete_sign_in(id).map_err(|e| e.to_string()),
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

    /// Records whether an account's tokens are in the keychain.
    fn mark_signed_in(&self, id: &str, signed_in: bool) -> Result<(), StoreError> {
        let _endpoints = self.endpoint_lock.lock().unwrap_or_else(|p| p.into_inner());
        let Some(mut stored) = self.store.endpoints()?.into_iter().find(|e| e.id == id) else {
            return Ok(());
        };
        let Some(sign_in) = stored.sign_in.as_mut() else {
            return Ok(());
        };
        if sign_in.signed_in == signed_in {
            return Ok(());
        }
        sign_in.signed_in = signed_in;
        self.store.update_endpoint(&stored)?;
        Ok(())
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
        if let Err(error) = accounts.keep(&id, &done.tokens).await {
            if added {
                let _endpoints = self.endpoint_lock.lock().unwrap_or_else(|p| p.into_inner());
                let _ = self.store.delete_endpoint(&id);
                let _ = self.sync_endpoints();
            }
            return Err(error.to_string());
        }
        let kept = {
            let _endpoints = self.endpoint_lock.lock().unwrap_or_else(|p| p.into_inner());
            match self
                .store
                .endpoints()
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|e| e.id == id)
            {
                Some(mut row) if !self.retiring(&id) => {
                    row.sign_in = Some(facts);
                    self.store
                        .update_endpoint(&row)
                        .map_err(|e| e.to_string())?;
                    self.sync_endpoints().map_err(|e| e.to_string())?;
                    true
                }
                _ => false,
            }
        };
        if !kept {
            // Removed while it signed in: the tokens just kept go too.
            let _ = accounts.forget(&id).await;
            return Err("the account was removed while signing in".to_owned());
        }
        if added {
            self.save_listed_models(&id).await;
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
        let id = self.free_sign_in_id(&endpoints);
        let name: String = done
            .account
            .email
            .clone()
            .unwrap_or_else(|| "ChatGPT".to_owned())
            .chars()
            .take(60)
            .collect();
        let row = StoredEndpoint {
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

    /// Saves the models a new account lists for itself, so it starts with what it may use. A
    /// list that can't be read leaves it empty: the person adds models from Settings.
    async fn save_listed_models(&self, id: &str) {
        let Ok(listed) = self.list_endpoint_models(id).await else {
            return;
        };
        for model in listed.into_iter().take(MOST_SAVED) {
            let saved = StoredModel {
                id: model.id,
                name: model.name,
                context: model.context,
                capabilities: model
                    .capabilities
                    .map(|c| c.iter().map(|c| c.name().to_owned()).collect()),
                source: "listed".to_owned(),
            };
            let _ = self.store.put_model(id, &saved);
        }
        let _ = self.sync_endpoints();
    }

    /// `chatgpt`, else `chatgpt-2` and on: free in the database and not being removed.
    fn free_sign_in_id(&self, endpoints: &[StoredEndpoint]) -> String {
        let taken: HashSet<&str> = endpoints.iter().map(|e| e.id.as_str()).collect();
        (1..)
            .map(|n| {
                if n == 1 {
                    CHATGPT.to_owned()
                } else {
                    format!("{CHATGPT}-{n}")
                }
            })
            .find(|id| !taken.contains(id.as_str()) && !self.retiring(id))
            .unwrap_or_else(|| CHATGPT.to_owned())
    }
}
