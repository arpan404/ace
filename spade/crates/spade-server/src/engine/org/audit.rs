//! What a shared bot's steps write to the host's audit log (ADR 0206 §4): each outward effect,
//! with the member who allowed it, written with the call's start; each answer, with its
//! `approval_answered`; each access change and new shared bot with its setting. Checkpoints are
//! signed with the host's audit key as they fall due.

use serde_json::Value;
use spade_core::event::Known;
use spade_core::org::audit::{self, Chained, Checkpoint, Entry, Ref};
use spade_core::org::{Member, gate};
use spade_core::{Event, effect};
use spade_store::{StoreError, StoredEvent};

use super::super::Engine;
use crate::org::{export, signer};

/// How a grant a member made names them in its `by` (ADR 0167 §5 for shared bots).
pub const MEMBER_BY: &str = "member:";

/// Who allowed an outward step: the reference ADR 0206 §4.1 names and the member's account.
struct Allower {
    by: String,
    account: Option<String>,
}

impl Engine {
    /// The host's audit key for `org`, made now if it has none.
    pub(crate) fn audit_key(&self, org: &str) -> Result<signer::AuditKey, String> {
        let keychain = self
            .keychain
            .as_ref()
            .ok_or_else(|| "this machine has no keychain to keep the audit key in".to_owned())?;
        signer::load_or_make(keychain, org, signer::os_seed)
    }

    /// An entry a member's step on shared bot `agent` writes.
    pub(super) fn bot_entry(
        &self,
        action: &str,
        agent: &str,
        member: &Member,
        changed: &[&str],
    ) -> Entry {
        let name = self
            .store
            .agent(agent)
            .ok()
            .flatten()
            .map(|a| a.name)
            .unwrap_or_default();
        let mut actor = Ref::new("member", &member.account);
        if let Some(named) = &member.name {
            actor = actor.named(named);
        }
        let entry = Entry::new(
            action,
            self.now_ms(),
            actor,
            vec![Ref::new("bot", agent).named(&name)],
        )
        .with("role", member.role.as_str());
        if changed.is_empty() {
            entry
        } else {
            entry.with("changed", changed.join(","))
        }
    }

    /// The `bot.approval.answered` entry for `member`'s answer to `call_id` in `conversation`.
    pub(crate) fn answer_entry(
        &self,
        conversation: &str,
        call_id: &str,
        allowed: bool,
        always: bool,
        member: &Member,
    ) -> Option<Entry> {
        let (agent, _) = self.shared_over(conversation)?;
        let answer = match (allowed, always) {
            (true, true) => "always",
            (true, false) => "allow",
            (false, _) => "deny",
        };
        let mut entry = self.bot_entry("bot.approval.answered", &agent, member, &[]);
        entry.targets.push(Ref::new("request", call_id));
        Some(entry.with("answer", answer).with("right", "approve"))
    }

    /// The `bot.effect` entry for a shared bot's outward call starting in `conversation`: its
    /// effect, who allowed it and a digest of its arguments (never the arguments). `None` for any
    /// other call.
    pub(crate) fn effect_entry(
        &self,
        conversation: &str,
        call_id: &str,
        name: &str,
        arguments: &Value,
        effect: Option<effect::Effect>,
    ) -> Option<Entry> {
        let (agent, _) = self.shared_over(conversation)?;
        // Read only for a shared bot's calls: who allowed one is in its answers.
        let events = self.load(conversation).ok()?;
        // Outward by what it declares, by declaring nothing, or by an approver's answer to it
        // (a command outside the sandbox): each is on the log.
        let answered = events.iter().any(|event| {
            matches!(event, Event::Known(Known::ApprovalAnswered { call_id: c, allowed: true, .. })
                if c == call_id)
        });
        if !(gate::outward(effect) || effect.is_none() || answered) {
            return None;
        }
        let bot = self.store.agent(&agent).ok().flatten();
        let mut targets = vec![Ref::new("bot", &agent).named(bot.as_ref().map_or("", |b| &b.name))];
        if let Some(host) = self.org_binding().map(|b| b.host) {
            targets.push(Ref::new("host", &host));
        }
        let text = |key: &str| arguments.get(key).and_then(Value::as_str);
        if let Some(repo) = text("repo") {
            targets.push(Ref::new("repo", repo));
        }
        if let Some(to) = text("to").or_else(|| text("recipient")) {
            targets.push(Ref::new("recipient", to));
        }
        let allower = self.allower(conversation, call_id, name, arguments, effect, &events);
        let mut entry = Entry::new(
            "bot.effect",
            self.now_ms(),
            Ref::new("bot", &agent),
            targets,
        )
        .with("effect", effect.map_or("undeclared", effect::Effect::name))
        .with("tool", name)
        .with("allowed_by", allower.by.as_str());
        if let Some(account) = &allower.account {
            entry = entry.with("allowed_by_account", account.as_str());
        }
        if !self.org_policy().targets_only() {
            let bytes = serde_json::to_vec(arguments).unwrap_or_default();
            entry = entry.with("args_sha256", audit::digest(&bytes));
        }
        if let Some((package, version)) = self.package_of(&agent) {
            entry = entry.with("package", package).with("version", version);
        }
        Some(entry)
    }

    /// Who allowed `call_id`: an approver's answer to it, an approver's Always allow for the
    /// tool, or a member's grant over it, in that order (ADR 0206 §4.1).
    fn allower(
        &self,
        conversation: &str,
        call_id: &str,
        name: &str,
        arguments: &Value,
        effect: Option<effect::Effect>,
        events: &[Event],
    ) -> Allower {
        let account = |by: &Option<Box<Member>>| by.as_ref().map(|m| m.account.clone());
        let answered = events.iter().rev().find_map(|event| match event {
            Event::Known(Known::ApprovalAnswered {
                call_id: c,
                allowed: true,
                by,
                ..
            }) if c == call_id => Some(Allower {
                by: format!("answer:{call_id}"),
                account: account(by),
            }),
            _ => None,
        });
        if let Some(answered) = answered {
            return answered;
        }
        let asked_for = |asked: &str| {
            events.iter().any(|event| {
                matches!(event, Event::Known(Known::ApprovalRequested { call_id: c, name: n, .. })
                    if c == asked && n == name)
            })
        };
        let always = events.iter().rev().find_map(|event| match event {
            Event::Known(Known::ApprovalAnswered {
                call_id: c,
                allowed: true,
                always: true,
                by,
                ..
            }) if asked_for(c) => Some(Allower {
                by: format!("always:{c}"),
                account: account(by),
            }),
            _ => None,
        });
        if let Some(always) = always {
            return always;
        }
        if let Some((_, grant)) = self.granting(conversation, name, arguments, effect) {
            return Allower {
                by: format!("grant:{}", grant.id),
                account: grant.by.strip_prefix(MEMBER_BY).map(str::to_owned),
            };
        }
        Allower {
            by: "none".to_owned(),
            account: None,
        }
    }

    /// The package link of a packaged bot: its name and installed version.
    fn package_of(&self, agent: &str) -> Option<(String, String)> {
        let text = self
            .store
            .setting(&spade_store::package_key(agent))
            .ok()??;
        let link: Value = serde_json::from_str(&text).ok()?;
        Some((
            link.get("name")?.as_str()?.to_owned(),
            link.get("version")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        ))
    }

    /// Stores `events` in conversation `id` with `entries` in the audit log, in one transaction,
    /// and sends the events on; the caller holds `record_lock`.
    pub(crate) fn append_audited(
        &self,
        id: &str,
        events: &[Event],
        entries: &[Entry],
    ) -> Result<Vec<StoredEvent>, StoreError> {
        if entries.is_empty() {
            return self.append_events(id, events);
        }
        let stored = self
            .store
            .append_audited(id, events, entries, self.now_ms());
        self.forget_activity(id);
        let (stored, _) = stored?;
        self.publish_stored(id, &stored);
        self.after_audit();
        Ok(stored)
    }

    /// [`Engine::append_audited`] for one event, taking `record_lock`.
    pub(crate) fn record_audited(
        &self,
        id: &str,
        event: &Event,
        entry: Option<Entry>,
    ) -> Result<(), StoreError> {
        let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
        let entries: Vec<Entry> = entry.into_iter().collect();
        self.append_audited(id, std::slice::from_ref(event), &entries)
            .map(|_| ())
    }

    /// After entries are written: a checkpoint, if one is due.
    pub(super) fn after_audit(&self) {
        if let Err(error) = self.org_checkpoint_if_due() {
            tracing::warn!(%error, "the audit log's checkpoint couldn't be signed");
        }
    }

    /// Signs a checkpoint over the chain's head when one is due (every 100 entries or five
    /// minutes), keeping it and its `audit.checkpoint` record. Answers it, when signed.
    pub fn org_checkpoint_if_due(&self) -> Result<Option<Checkpoint>, String> {
        let Some(binding) = self.org_binding() else {
            return Ok(None);
        };
        let (unsigned, oldest) = self.store.audit_unsigned().map_err(|e| e.to_string())?;
        if !audit::checkpoint_due(unsigned, oldest, self.now_ms()) {
            return Ok(None);
        }
        let Some(head) = self.store.audit_head().map_err(|e| e.to_string())? else {
            return Ok(None);
        };
        let key = self.audit_key(&binding.org)?;
        let now = self.now_ms();
        let checkpoint = key.checkpoint(&binding.org, &binding.host, head.count, &head.hash, now);
        let record = Entry::new(
            "audit.checkpoint",
            now,
            Ref::new("host", &binding.host),
            vec![Ref::new("host", &binding.host)],
        )
        .with("head", head.hash.as_str())
        .with("count", head.count)
        .with("signature", checkpoint.signature.as_str());
        let kept = self
            .store
            .put_checkpoint(&checkpoint, &record, now)
            .map_err(|e| e.to_string())?;
        Ok(kept.then_some(checkpoint))
    }

    /// Entries the daemon records itself (membership seen, a host shell, enrollment), through
    /// Spade's loopback API.
    pub fn org_record(&self, entries: &[Entry]) -> Result<Vec<Chained>, StoreError> {
        let chained = self.store.audit(entries, self.now_ms())?;
        self.after_audit();
        Ok(chained)
    }

    /// The outbox: entries the backend hasn't taken, oldest first. A checkpoint due by time is
    /// signed first, so the copy outside the host has it as soon as it can.
    pub fn org_outbox(&self, limit: usize) -> Result<Vec<Chained>, StoreError> {
        self.after_audit();
        self.store.audit_outbox(limit)
    }

    /// The backend took every entry through `through`.
    pub fn org_forwarded(&self, through: i64) -> Result<usize, StoreError> {
        self.store.audit_forwarded(through, self.now_ms())
    }

    /// The log written from `from_ms` through `to_ms`, as `ace org audit export` writes it.
    pub fn org_export(&self, from_ms: i64, to_ms: i64) -> Result<String, String> {
        let binding = self
            .org_binding()
            .ok_or_else(|| "this Spade doesn't belong to an organization".to_owned())?;
        let key = self
            .audit_key(&binding.org)
            .map(|key| key.public())
            .unwrap_or_default();
        export::export(&self.store, &binding, &key, from_ms, to_ms).map_err(|e| e.to_string())
    }
}
