// SPDX-License-Identifier: Apache-2.0
//! `ToolRegistry` (`registry.ts:207`–`:607`): the tools this server offers, the calls it admits
//! and the deadlines, budgets and refusals it applies, in the TypeScript's order.
//!
//! A registration carries the descriptor from M1's catalog and a handler. The registry decides
//! what a caller may see and may call: capability, availability (a group that is off), admission,
//! call slots, the one deadline, the input and result budgets. It never adds an approval:
//! annotations tell the provider what a tool does, and the provider's own permission mode
//! decides. ace hides only what it cannot serve.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};

use ace_json::Value;
use futures::future::BoxFuture;

use crate::calls::Calls;
use crate::catalog::Tool as Descriptor;
use crate::json_budget::within_json_budget;
use crate::limits::{
    DEFAULT_MAX_INPUT_BYTES, MAX_CALLS, MAX_CALLS_PER_THREAD, MAX_STRUCTURED_RESULT_BYTES,
    MAX_TOOL_TIMEOUT_MS, MAX_TOOLS,
};
use crate::public_error::{
    PublicToolError, ToolFailure, fixed_failure, input_too_large, tool_failure,
};
use crate::result::CallToolResult;
use crate::signal::{Abort, Scheduler};
use crate::tool_names::{bare_tool_name, default_tool_title, default_toolset, valid_tool_name};
use crate::toolsets::{AceClient, ToolListing};

/// Who a call runs as (`McpAttribution`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attribution {
    pub session_id: String,
    pub thread_id: String,
    pub agent_id: String,
}

/// What the server lends a tool about the calling session (`ToolContext`).
#[derive(Clone)]
pub struct ToolContext {
    pub caller: Attribution,
    pub capabilities: Vec<String>,
    pub signal: Abort,
    pub listing: Option<ToolListing>,
    pub client: Option<AceClient>,
    pub call_budget_seconds: Option<u64>,
    /// The client's `_meta["ace/acting-for"]`, never the tool's arguments.
    pub acting_for: Option<String>,
}

/// A tool's work. It returns the structured value; the registry stringifies and bounds it.
pub trait ToolHandler: Send + Sync + 'static {
    fn call(
        &self,
        input: Value,
        context: ToolContext,
    ) -> BoxFuture<'static, Result<Value, ToolFailure>>;
}

/// `Fn(Value, ToolContext) -> future`, for the daemon's small tools and tests.
pub struct FnTool<F>(pub F);

impl<F, Fut> ToolHandler for FnTool<F>
where
    F: Fn(Value, ToolContext) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<Value, ToolFailure>> + Send + 'static,
{
    fn call(
        &self,
        input: Value,
        context: ToolContext,
    ) -> BoxFuture<'static, Result<Value, ToolFailure>> {
        Box::pin((self.0)(input, context))
    }
}

/// A host's record of a result, run after the reply decision (`observeCall`).
pub type ObserveFinish = Box<dyn FnOnce(&CallToolResult) -> BoxFuture<'static, ()> + Send>;
pub type CallObserver =
    Arc<dyn Fn(&str, &Value, &ToolContext) -> Option<ObserveFinish> + Send + Sync>;
pub type CallAdmission = Arc<dyn Fn(&str, &Value, &Attribution) -> bool + Send + Sync>;
pub type CallSignal = Arc<dyn Fn(&str, Option<&str>, &Attribution) -> Option<Abort> + Send + Sync>;
pub type Availability = Arc<dyn Fn(&Attribution, &str, Option<&str>) -> bool + Send + Sync>;
pub type FailureReporter =
    Arc<dyn Fn(&str, &Attribution, &ToolFailure) -> Option<String> + Send + Sync>;

/// Whom one call runs as when the host swaps the caller's attribution (`CallAct`).
pub struct CallAct {
    pub caller: Attribution,
    pub signal: Option<Abort>,
    pub settled: Option<Box<dyn FnOnce() + Send>>,
}

/// Decides whom one call runs as, or refuses it by returning a failure.
pub type CallActor = Arc<
    dyn Fn(
            &str,
            Option<&str>,
            &Attribution,
            Option<&str>,
        ) -> BoxFuture<'static, Result<Option<CallAct>, ToolFailure>>
        + Send
        + Sync,
>;

/// A tool's own rule for a failed result.
pub type Failed = Arc<dyn Fn(&Value) -> bool + Send + Sync>;
/// A tool's own output contract.
pub type OutputCheck = Arc<dyn Fn(&Value) -> Result<(), String> + Send + Sync>;

/// One registered tool.
pub struct ToolEntry {
    pub descriptor: Descriptor,
    /// Deletes, overwrites or spends: the only ace tools a provider should gate itself.
    pub destructive: bool,
    /// Spade's word for a publishing tool, sent as `_meta["ace/effect"]`.
    pub effect: Option<&'static str>,
    pub max_input_bytes: usize,
    pub failed: Option<Failed>,
    /// The tool's own output contract, checked before the result leaves.
    pub output_check: Option<OutputCheck>,
    pub handler: Arc<dyn ToolHandler>,
}

impl ToolEntry {
    pub fn new(descriptor: Descriptor, handler: Arc<dyn ToolHandler>) -> ToolEntry {
        ToolEntry {
            descriptor,
            destructive: false,
            effect: None,
            max_input_bytes: DEFAULT_MAX_INPUT_BYTES,
            failed: None,
            output_check: None,
            handler,
        }
    }

    pub fn destructive(mut self, destructive: bool) -> Self {
        self.destructive = destructive;
        self
    }

    pub fn effect(mut self, effect: &'static str) -> Self {
        self.effect = Some(effect);
        self
    }

    pub fn max_input_bytes(mut self, bytes: usize) -> Self {
        self.max_input_bytes = bytes;
        self
    }

    pub fn failed_when(mut self, failed: impl Fn(&Value) -> bool + Send + Sync + 'static) -> Self {
        self.failed = Some(Arc::new(failed));
        self
    }

    pub fn check_output(
        mut self,
        check: impl Fn(&Value) -> Result<(), String> + Send + Sync + 'static,
    ) -> Self {
        self.output_check = Some(Arc::new(check));
        self
    }
}

/// Why a registration was refused; every message is `registry.ts`'s own.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RegistrationError {
    #[error("Invalid or duplicate tool name")]
    Name,
    #[error("Tool capacity reached")]
    Capacity,
    #[error("Invalid tool timeout")]
    Timeout,
}

/// What one call is told about how the client lists tools (`ToolContext`'s options).
#[derive(Debug, Clone, Default)]
pub struct CallOptions {
    pub listing: Option<ToolListing>,
    pub client: Option<AceClient>,
    pub call_budget_seconds: Option<u64>,
    pub acting_for: Option<String>,
}

/// The registry's host hooks (`McpServerOptions`). They stay ports until M3.
#[derive(Default)]
pub struct Hooks {
    pub availability: Option<Availability>,
    pub observe_call: Option<CallObserver>,
    pub admit: Option<CallAdmission>,
    pub call_signal: Option<CallSignal>,
    pub act_as: Option<CallActor>,
    pub report_failure: Option<FailureReporter>,
}

impl std::fmt::Debug for Hooks {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Hooks")
    }
}

struct Entry {
    descriptor: Descriptor,
    toolset: Option<String>,
    capability: Option<String>,
    timeout_ms: u64,
    destructive: bool,
    effect: Option<&'static str>,
    max_input_bytes: usize,
    failed: Option<Failed>,
    output_check: Option<OutputCheck>,
    handler: Arc<dyn ToolHandler>,
}

impl Entry {
    fn name(&self) -> &str {
        &self.descriptor.name
    }
}

/// The registry one server serves from.
pub struct ToolRegistry {
    entries: Mutex<Vec<Arc<Entry>>>,
    /// Bare name to its entry, so every provider spelling reaches it.
    by_bare: Mutex<HashMap<String, Arc<Entry>>>,
    calls: Arc<Mutex<Calls>>,
    scheduler: Arc<dyn Scheduler>,
    hooks: Hooks,
    max_tools: usize,
    generation: AtomicU8,
}

impl std::fmt::Debug for ToolRegistry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ToolRegistry")
            .field("tools", &self.names())
            .finish_non_exhaustive()
    }
}

impl ToolRegistry {
    pub fn new(scheduler: Arc<dyn Scheduler>) -> ToolRegistry {
        ToolRegistry::with_limits(scheduler, MAX_TOOLS)
    }

    pub fn with_limits(scheduler: Arc<dyn Scheduler>, max_tools: usize) -> ToolRegistry {
        ToolRegistry {
            entries: Mutex::new(Vec::new()),
            by_bare: Mutex::new(HashMap::new()),
            calls: Arc::new(Mutex::new(Calls::new(MAX_CALLS, MAX_CALLS_PER_THREAD))),
            scheduler,
            hooks: Hooks::default(),
            max_tools,
            generation: AtomicU8::new(0),
        }
    }

    /// The bound every call's slots are counted against (tests pass small ones).
    pub fn with_call_limits(mut self, max_calls: usize, max_calls_per_thread: usize) -> Self {
        self.calls = Arc::new(Mutex::new(Calls::new(max_calls, max_calls_per_thread)));
        self
    }

    pub fn with_hooks(mut self, hooks: Hooks) -> Self {
        self.hooks = hooks;
        self
    }

    /// Registers one tool; `registry.ts:313`–`:328`'s checks.
    pub fn register(&self, entry: ToolEntry) -> Result<(), RegistrationError> {
        let descriptor = entry.descriptor;
        let name = descriptor.name.clone();
        if !valid_tool_name(&name)
            || (name.starts_with("browser_") && descriptor.capability.as_deref() != Some("browser"))
            || (name.starts_with("screen_") && descriptor.capability.as_deref() != Some("screen"))
            || (name.starts_with("sim_") && descriptor.capability.as_deref() != Some("devices"))
        {
            return Err(RegistrationError::Name);
        }
        // `Number.isSafeInteger(timeoutMs) && 1 <= timeoutMs <= maxToolTimeoutMs`: a fractional
        // timeout is refused, never truncated into range.
        let timeout = descriptor.timeout_ms.unwrap_or(MAX_TOOL_TIMEOUT_MS as f64);
        if !timeout.is_finite()
            || timeout.fract() != 0.0
            || !(1.0..=MAX_TOOL_TIMEOUT_MS as f64).contains(&timeout)
        {
            return Err(RegistrationError::Timeout);
        }
        let timeout_ms = timeout as u64;
        let bare = bare_tool_name(&name);
        let toolset = descriptor
            .toolset
            .clone()
            .or_else(|| default_toolset(&name).map(str::to_owned));
        let capability = descriptor.capability.clone();
        let mut by_bare = self
            .by_bare
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if by_bare.contains_key(&bare) {
            return Err(RegistrationError::Name);
        }
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if entries.len() >= self.max_tools {
            return Err(RegistrationError::Capacity);
        }
        let entry = Arc::new(Entry {
            descriptor,
            toolset,
            capability,
            timeout_ms,
            destructive: entry.destructive,
            effect: entry.effect,
            max_input_bytes: entry.max_input_bytes,
            failed: entry.failed,
            output_check: entry.output_check,
            handler: entry.handler,
        });
        entries.push(Arc::clone(&entry));
        by_bare.insert(bare, entry);
        self.generation.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    pub fn names(&self) -> Vec<String> {
        self.entries()
            .iter()
            .map(|entry| entry.name().to_owned())
            .collect()
    }

    pub fn has(&self, name: &str) -> bool {
        self.resolve(name).is_some()
    }

    /// The guide topic a tool's family belongs to, if it has one.
    pub fn toolset(&self, name: &str) -> Option<String> {
        self.resolve(name).and_then(|entry| entry.toolset.clone())
    }

    pub fn capability(&self, name: &str) -> Option<String> {
        self.resolve(name)
            .and_then(|entry| entry.capability.clone())
    }

    /// Every capability at least one registered tool needs (`registry.ts:407`).
    pub fn capabilities(&self) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();
        for entry in self.entries() {
            if let Some(capability) = &entry.capability
                && !names.contains(capability)
            {
                names.push(capability.clone());
            }
        }
        names
    }

    /// A generation that changes on every registration, so a session knows to reload.
    pub fn version(&self) -> u8 {
        self.generation.load(Ordering::SeqCst)
    }

    /// The descriptors this caller may see, in registration order (`registry.ts:433`).
    pub fn list(&self, principal: &crate::credentials::Principal) -> Vec<Descriptor> {
        if principal.lifetime.aborted() {
            return Vec::new();
        }
        self.entries()
            .into_iter()
            .filter(|entry| self.offered(entry, principal))
            .map(|entry| entry.descriptor.clone())
            .collect()
    }

    /// The descriptors of a family this caller is offered, for a guide's inline schemas.
    pub fn describe(
        &self,
        toolset: &str,
        caller: &Attribution,
        capabilities: &[String],
    ) -> Vec<Descriptor> {
        self.entries()
            .into_iter()
            .filter(|entry| {
                entry.toolset.as_deref() == Some(toolset)
                    && self.offered_parts(entry, caller, capabilities)
            })
            .map(|entry| entry.descriptor.clone())
            .collect()
    }

    /// The approval target a call shows (`registry.ts:396`): a `tools_call` reads as the call it
    /// runs. The input is not re-validated here; a Rust family's decoder has already run, and the
    /// engine's own gate validates what it forwards.
    pub fn action(&self, name: &str, input: &Value) -> Option<Value> {
        let call = crate::tool_names::dispatched_ace_call(name, input);
        let entry = self.resolve(&call.name)?;
        Some(crate::action::describe_ace_action(
            &entry.descriptor.name,
            &entry.descriptor.description,
            Some(&entry.descriptor.risk_class),
            &call.input,
        ))
    }

    /// The fields `name` mirrors into headers, read from its own advertised schema
    /// (`x-mcp-header`), the one source the SDK also reads (`http.ts:432`).
    pub fn param_headers(&self, name: &str) -> Vec<(String, String)> {
        let Some(entry) = self.resolve(name) else {
            return Vec::new();
        };
        let Some(properties) = entry
            .descriptor
            .input
            .get("properties")
            .and_then(Value::as_object)
        else {
            return Vec::new();
        };
        properties
            .iter()
            .filter_map(|(field, schema)| {
                schema
                    .get("x-mcp-header")
                    .and_then(Value::as_str)
                    .map(|header| (field.as_str().to_owned(), header.to_owned()))
            })
            .collect()
    }

    /// Whether a provider should gate `name` itself (`ToolEntry::destructive`).
    pub fn destructive(&self, name: &str) -> bool {
        self.resolve(name).is_some_and(|entry| entry.destructive)
    }

    /// The input schema a caller may see for `name`.
    pub fn input_schema(
        &self,
        name: &str,
        principal: &crate::credentials::Principal,
    ) -> Option<Value> {
        if principal.lifetime.aborted() {
            return None;
        }
        let entry = self.resolve(name)?;
        self.offered(&entry, principal)
            .then(|| entry.descriptor.input.clone())
    }

    /// The annotations and `_meta` a descriptor is served with (`registry.ts:333`–`:380`).
    pub fn descriptor_json(&self, descriptor: &Descriptor) -> Value {
        self.descriptor_json_as(descriptor, None)
    }

    /// The same descriptor with `destructiveHint` replaced where the list says so: a Codex
    /// fixed list marks `tools_call` non-destructive because it refuses destructive targets
    /// (`http.ts:543`).
    pub fn descriptor_json_as(&self, descriptor: &Descriptor, destructive: Option<bool>) -> Value {
        let entry = self.resolve(&descriptor.name);
        let destructive =
            destructive.unwrap_or_else(|| entry.as_ref().is_some_and(|entry| entry.destructive));
        let effect = entry.as_ref().and_then(|entry| entry.effect);
        descriptor_json(descriptor, destructive, effect)
    }

    /// `registry.ts:460`: one call, with every refusal in the TypeScript's order.
    pub async fn call(
        &self,
        name: &str,
        input: Value,
        principal: &crate::credentials::Principal,
        request: &Abort,
        options: CallOptions,
    ) -> CallToolResult {
        if principal.lifetime.aborted() {
            return fixed_failure("session_ended");
        }
        let Some(entry) = self.resolve(name) else {
            return fixed_failure("tool_unavailable");
        };
        if !self.allowed(&entry, principal) {
            return fixed_failure("tool_unavailable");
        }
        let caller = attribution(principal);
        if let Some(admit) = &self.hooks.admit
            && !admit(&entry.descriptor.name, &input, &caller)
        {
            return fixed_failure("host_policy_refused");
        }
        if !self
            .calls
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .admits(&caller.thread_id)
        {
            return fixed_failure("calls_limit");
        }
        let controller = Abort::new();
        let acted = Abort::new();
        let expired = Abort::new();
        let mut signals = vec![
            principal.lifetime.clone(),
            request.clone(),
            controller.clone(),
            acted.clone(),
        ];
        let host =
            self.hooks.call_signal.as_ref().and_then(|host| {
                host(&entry.descriptor.name, entry.capability.as_deref(), &caller)
            });
        if let Some(host) = host {
            signals.push(host);
        }
        let signal = Abort::any(signals);
        let context = ToolContext {
            caller: caller.clone(),
            capabilities: principal.scope.capabilities.clone(),
            signal: signal.clone(),
            listing: options.listing,
            client: options.client,
            call_budget_seconds: options.call_budget_seconds,
            acting_for: options.acting_for.clone(),
        };
        let observe = self
            .hooks
            .observe_call
            .as_ref()
            .and_then(|observe| observe(&entry.descriptor.name, &input, &context));
        let reason = Arc::new(AtomicU8::new(REASON_CANCELLED));
        let deadline = {
            let reason = Arc::clone(&reason);
            let controller = controller.clone();
            let expired = expired.clone();
            self.scheduler.after(
                entry.timeout_ms,
                Box::new(move || {
                    reason.store(REASON_TIMEOUT, Ordering::SeqCst);
                    controller.abort();
                    expired.abort();
                }),
            )
        };
        {
            let mut calls = self.calls.lock().unwrap_or_else(|error| error.into_inner());
            if !calls.take(&caller.thread_id) {
                deadline();
                return fixed_failure("calls_limit");
            }
        }
        let slot = Arc::new(Slot::new(Arc::clone(&self.calls), caller.thread_id.clone()));
        // The caller's side of the slot: its drop settles the observation, and, when the tool was
        // never handed to a task, the execution too. A dropped `call` future therefore releases
        // what nothing else will (`http.ts:577`).
        let mut call_slot = CallSlot {
            slot: Arc::clone(&slot),
            spawned: false,
        };
        if signal.aborted() {
            let result = self
                .finish(fixed_failure("cancelled"), observe, &expired)
                .await;
            deadline();
            return result;
        }
        let mut act = None;
        if let Some(actor) = &self.hooks.act_as {
            let answered = actor(
                &entry.descriptor.name,
                entry.capability.as_deref(),
                &context.caller,
                context.acting_for.as_deref(),
            );
            let outcome = tokio::select! {
                outcome = answered => Some(outcome),
                () = signal.wait() => None,
            };
            match outcome {
                None => {
                    let result = self
                        .finish(self.reason_failure(&reason), observe, &expired)
                        .await;
                    deadline();
                    return result;
                }
                Some(Err(failure)) => {
                    let result = self
                        .finish(self.reported(&entry, &caller, failure), observe, &expired)
                        .await;
                    deadline();
                    return result;
                }
                Some(Ok(answer)) => act = answer,
            }
        }
        if let Some(act_signal) = act.as_ref().and_then(|act| act.signal.clone()) {
            if act_signal.aborted() {
                acted.abort();
            } else {
                let acted = acted.clone();
                act_signal.on_abort(Box::new(move || acted.abort()));
            }
        }
        if signal.aborted() {
            if let Some(act) = act.take()
                && let Some(settled) = act.settled
            {
                settled();
            }
            let result = self
                .finish(self.reason_failure(&reason), observe, &expired)
                .await;
            deadline();
            return result;
        }
        let run_as = match &act {
            Some(act) => ToolContext {
                caller: act.caller.clone(),
                ..context.clone()
            },
            None => context.clone(),
        };
        if !within_json_budget(&input, entry.max_input_bytes) {
            if let Some(act) = act.take()
                && let Some(settled) = act.settled
            {
                settled();
            }
            let result = self
                .finish(
                    tool_failure(ToolFailure::Public(Box::new(input_too_large(
                        entry.max_input_bytes,
                    )))),
                    observe,
                    &expired,
                )
                .await;
            deadline();
            return result;
        }
        let bare = bare_tool_name(&entry.descriptor.name);
        let handler = Arc::clone(&entry.handler);
        let output_check = entry.output_check.clone();
        let failed = entry.failed.clone();
        let mut executed = tokio::spawn(async move {
            // The execution slot belongs to the tool's own task: an uncooperative backend keeps
            // it until it settles, even after the reply has gone.
            let settled = SettleExecution(Arc::clone(&slot));
            let outcome = match handler.call(input, run_as).await {
                Ok(value) => {
                    if !within_json_budget(&value, MAX_STRUCTURED_RESULT_BYTES) {
                        return Err(ToolFailure::Public(Box::new(public("result_too_large"))));
                    }
                    if let Some(check) = output_check
                        && let Err(detail) = check(&value)
                    {
                        return Err(ToolFailure::InvalidData(format!(
                            "{bare}: its result breaks the output schema in {detail}."
                        )));
                    }
                    let text = ace_json::to_string(&value);
                    if text.len() > MAX_STRUCTURED_RESULT_BYTES {
                        return Err(ToolFailure::Public(Box::new(public("result_too_large"))));
                    }
                    let is_error = failed.as_ref().is_some_and(|failed| failed(&value));
                    Ok((value, is_error))
                }
                Err(failure) => Err(failure),
            };
            drop(settled);
            outcome
        });
        call_slot.spawned = true;
        tokio::select! {
            joined = &mut executed => {
                let result = match joined {
                    Ok(Ok((value, is_error))) => CallToolResult::structured(is_error, value),
                    Ok(Err(failure)) => self.reported(&entry, &caller, failure),
                    Err(_) => fixed_failure("execution_failed"),
                };
                if let Some(act) = act.take()
                    && let Some(settled) = act.settled
                {
                    settled();
                }
                let result = self.finish(result, observe, &expired).await;
                deadline();
                result
            }
            () = signal.wait() => {
                if let Some(act) = act.take()
                    && let Some(settled) = act.settled
                {
                    settled();
                }
                let result = self.finish(self.reason_failure(&reason), observe, &expired).await;
                deadline();
                result
            }
        }
    }

    /// Waits for the host's observation, but never past the call's deadline: a stalled write
    /// carries on alone.
    async fn finish(
        &self,
        result: CallToolResult,
        observe: Option<ObserveFinish>,
        expired: &Abort,
    ) -> CallToolResult {
        let Some(observe) = observe else {
            return result;
        };
        let mut observed = observe(&result);
        tokio::select! {
            () = &mut observed => {}
            () = expired.wait() => {
                tokio::spawn(observed);
            }
        }
        result
    }

    fn reason_failure(&self, reason: &AtomicU8) -> CallToolResult {
        if reason.load(Ordering::SeqCst) == REASON_TIMEOUT {
            fixed_failure("tool_timeout")
        } else {
            fixed_failure("cancelled")
        }
    }

    fn reported(
        &self,
        entry: &Entry,
        caller: &Attribution,
        failure: ToolFailure,
    ) -> CallToolResult {
        self.attribute_failure(
            failure,
            &entry.descriptor.name,
            caller,
            self.hooks.report_failure.as_ref(),
        )
    }

    /// A private cause goes to the host's log; the agent gets only the record's id.
    fn attribute_failure(
        &self,
        failure: ToolFailure,
        name: &str,
        caller: &Attribution,
        report: Option<&FailureReporter>,
    ) -> CallToolResult {
        match failure {
            ToolFailure::Public(_) | ToolFailure::InvalidData(_) => tool_failure(failure),
            ToolFailure::Private(message) => {
                let id =
                    report.and_then(|report| report(name, caller, &ToolFailure::Private(message)));
                match id.and_then(|id| {
                    PublicToolError::new("execution_failed").map(|error| error.with_error_id(&id))
                }) {
                    Some(error) => tool_failure(ToolFailure::Public(Box::new(error))),
                    None => fixed_failure("execution_failed"),
                }
            }
        }
    }

    fn offered(&self, entry: &Entry, principal: &crate::credentials::Principal) -> bool {
        self.offered_parts(
            entry,
            &attribution(principal),
            &principal.scope.capabilities,
        )
    }

    fn offered_parts(&self, entry: &Entry, caller: &Attribution, capabilities: &[String]) -> bool {
        (entry.capability.is_none()
            || entry
                .capability
                .as_ref()
                .is_some_and(|needed| capabilities.contains(needed)))
            && self.hooks.availability.as_ref().is_none_or(|available| {
                available(caller, &entry.descriptor.name, entry.capability.as_deref())
            })
    }

    fn allowed(&self, entry: &Entry, principal: &crate::credentials::Principal) -> bool {
        self.offered(entry, principal)
    }

    fn entries(&self) -> Vec<Arc<Entry>> {
        self.entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn resolve(&self, name: &str) -> Option<Arc<Entry>> {
        if let Some(entry) = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .find(|entry| entry.descriptor.name == name)
        {
            return Some(Arc::clone(entry));
        }
        let bare = bare_tool_name(name);
        self.by_bare
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&bare)
            .cloned()
    }
}

fn public(code: &str) -> PublicToolError {
    PublicToolError::new(code).unwrap_or_else(|| PublicToolError {
        code: code.to_owned(),
        message: String::new(),
        hint: String::new(),
        detail: None,
        phase: None,
        candidates: None,
        issues: None,
        permission: None,
        error_id: None,
        blocked: None,
    })
}

fn attribution(principal: &crate::credentials::Principal) -> Attribution {
    Attribution {
        session_id: principal.scope.session_id.clone(),
        thread_id: principal.scope.thread_id.clone(),
        agent_id: principal.scope.agent_id.clone(),
    }
}

const REASON_CANCELLED: u8 = 0;
const REASON_TIMEOUT: u8 = 1;

/// The caller's side of a taken slot: dropping the `call` future settles the observation, and
/// the execution when the tool was never handed to its own task, so nothing waits forever.
struct CallSlot {
    slot: Arc<Slot>,
    spawned: bool,
}

impl Drop for CallSlot {
    fn drop(&mut self) {
        self.slot.settle_observation();
        if !self.spawned {
            self.slot.settle_execution();
        }
    }
}

/// Settles the execution when the tool's task ends, panic included.
struct SettleExecution(Arc<Slot>);

impl Drop for SettleExecution {
    fn drop(&mut self) {
        self.0.settle_execution();
    }
}

/// One taken slot, released when both the tool and the observation of its result have settled.
struct Slot {
    calls: Arc<Mutex<Calls>>,
    thread: String,
    execution: AtomicBool,
    observation: AtomicBool,
    released: AtomicBool,
}

impl Slot {
    fn new(calls: Arc<Mutex<Calls>>, thread: String) -> Slot {
        Slot {
            calls,
            thread,
            execution: AtomicBool::new(false),
            observation: AtomicBool::new(false),
            released: AtomicBool::new(false),
        }
    }

    fn settle_execution(&self) {
        self.execution.store(true, Ordering::SeqCst);
        self.maybe_release();
    }

    fn settle_observation(&self) {
        self.observation.store(true, Ordering::SeqCst);
        self.maybe_release();
    }

    fn maybe_release(&self) {
        if self.execution.load(Ordering::SeqCst)
            && self.observation.load(Ordering::SeqCst)
            && !self.released.swap(true, Ordering::SeqCst)
        {
            self.calls
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .release(&self.thread);
        }
    }
}

/// The annotations and `_meta` a descriptor is served with, in `registry.ts:341`'s key order.
pub fn descriptor_json(descriptor: &Descriptor, destructive: bool, effect: Option<&str>) -> Value {
    use ace_json::{JsString, Map};
    let name = &descriptor.name;
    let bare = bare_tool_name(name);
    let risk = &descriptor.risk_class;
    let title = if descriptor.title.is_empty() {
        default_tool_title(name)
    } else {
        descriptor.title.clone()
    };
    let has_request_id = descriptor
        .input
        .get("properties")
        .and_then(|properties| properties.get("requestId"))
        .is_some();
    let mut annotations = Map::with_capacity(5);
    annotations.insert("title", Value::String(JsString::from(title.as_str())));
    annotations.insert("readOnlyHint", Value::Bool(risk == "read-only"));
    annotations.insert("destructiveHint", Value::Bool(destructive));
    annotations.insert(
        "idempotentHint",
        Value::Bool(risk == "read-only" || has_request_id),
    );
    annotations.insert(
        "openWorldHint",
        Value::Bool(descriptor.open_world.unwrap_or(risk == "external-effect")),
    );
    let mut meta = Map::with_capacity(5);
    meta.insert(
        "ace/timeoutMs",
        Value::from(descriptor.timeout_ms.unwrap_or(MAX_TOOL_TIMEOUT_MS as f64)),
    );
    meta.insert(
        "ace/riskClass",
        Value::String(JsString::from(risk.as_str())),
    );
    if let Some(effect) = effect {
        meta.insert("ace/effect", Value::from(effect));
    }
    if matches!(bare.as_str(), "context" | "delegate") {
        meta.insert("anthropic/alwaysLoad", Value::Bool(true));
    }
    if matches!(
        bare.as_str(),
        "context" | "delegate" | "wait" | "guide" | "tools_find"
    ) {
        meta.insert("antigravity/alwaysLoad", Value::Bool(true));
    }
    let mut tool = Map::with_capacity(7);
    tool.insert("name", Value::String(JsString::from(name.as_str())));
    tool.insert("title", Value::String(JsString::from(title.as_str())));
    tool.insert(
        "description",
        Value::String(JsString::from(descriptor.description.as_str())),
    );
    tool.insert("annotations", Value::Object(annotations));
    tool.insert("_meta", Value::Object(meta));
    tool.insert("inputSchema", descriptor.input.clone());
    if let Some(output) = &descriptor.output {
        tool.insert("outputSchema", output.clone());
    }
    Value::Object(tool)
}

/// A descriptor for a tool this server builds itself (a test's, or a family registered before
/// the catalog exports it).
#[allow(clippy::too_many_arguments)]
pub fn descriptor(
    name: &str,
    title: Option<&str>,
    description: &str,
    risk_class: &str,
    capability: Option<&str>,
    timeout_ms: u64,
    input: Value,
    output: Option<Value>,
) -> Descriptor {
    Descriptor {
        name: name.to_owned(),
        title: title.map_or_else(|| default_tool_title(name), str::to_owned),
        toolset: default_toolset(name).map(str::to_owned),
        risk_class: risk_class.to_owned(),
        open_world: None,
        description: description.to_owned(),
        capability: capability.map(str::to_owned),
        timeout_ms: Some(timeout_ms as f64),
        input,
        output,
    }
}

#[cfg(test)]
#[path = "registry/tests.rs"]
mod tests;
