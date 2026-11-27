// SPDX-License-Identifier: Apache-2.0
//! Local `gh stack` rebase/restack and leased stack publication (`local-stacks.ts`).

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use ace_json::{Map, Value};

use crate::github::stacks::{HostStack, LocalStackOperation};
use crate::pure::stack_plan::{
    ForgeLocalBranch, ForgeLocalStack, ForgeStack as PlanStack, ForgeStackExpected, LocalBranchPr,
    PublishOutcome, STACK_REBASED_LOCALLY, StackPublishReport, StackPublishUpdate,
    can_publish_stack, matches_local_stack, matches_stack_branches, plan_stack_publication,
    same_local_stack, stack_publish_result,
};
use crate::transport::command::{Cancellation, CommandRequest, Mode, Runner};
use crate::transport::error::{ForgeError, Kind};
use crate::transport::mutation::MutationDispatch;
use crate::transport::redact::redact_data;

/// Atomic leased-push request passed to a [`StackPublisher`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StackPushSpec {
    pub remote: String,
    pub updates: Vec<StackPushRefUpdate>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StackPushRefUpdate {
    pub git_ref: String,
    pub lease: String,
    pub target: String,
}

/// Publishes rebased stack layers with one atomic leased push (`StackPublisher`).
pub trait StackPublisher: Send + Sync {
    fn publish<'a>(
        &'a self,
        spec: StackPushSpec,
        cancellation: Option<Arc<Cancellation>>,
        before_dispatch: Box<dyn FnOnce() + Send + 'a>,
    ) -> Pin<Box<dyn Future<Output = Result<StackPublishReport, ForgeError>> + Send + 'a>>;
}

/// Local `gh stack` rebase/restack and leased stack publication (`LocalStacks`).
pub struct LocalStacks<'a> {
    runner: &'a dyn Runner,
    command: String,
    publisher: Option<Arc<dyn StackPublisher>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalRebaseAction {
    Rebase,
    Continue,
    Abort,
    Push,
}

impl LocalRebaseAction {
    fn as_str(self) -> &'static str {
        match self {
            LocalRebaseAction::Rebase => "rebase",
            LocalRebaseAction::Continue => "continue",
            LocalRebaseAction::Abort => "abort",
            LocalRebaseAction::Push => "push",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestackStep {
    Upstack,
    Continue,
    Abort,
}

fn bounded_text(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?;
    if s.chars().count() > 65_536 {
        return None;
    }
    Some(s.to_owned())
}

fn pos_u64(v: Option<&Value>) -> Option<u64> {
    let n = v?.as_u64()?;
    if n == 0 { None } else { Some(n) }
}

impl<'a> LocalStacks<'a> {
    pub fn new(
        runner: &'a dyn Runner,
        command: impl Into<String>,
        publisher: Option<Arc<dyn StackPublisher>>,
    ) -> Self {
        Self {
            runner,
            command: command.into(),
            publisher,
        }
    }

    pub async fn read(
        &self,
        cancellation: Option<Arc<Cancellation>>,
    ) -> Result<(ForgeLocalStack, Value), ForgeError> {
        let mut req = CommandRequest::new(
            self.command.clone(),
            vec![
                String::from("stack"),
                String::from("view"),
                String::from("--json"),
            ],
        );
        req.mode = Mode::Json;
        req.cancellation = cancellation;
        let response = self.runner.run(req).await?;
        if response.code != Some(0) {
            return Err(ForgeError::new(Kind::Unsupported));
        }
        let parsed =
            ace_json::parse(&response.stdout).map_err(|_| ForgeError::new(Kind::InvalidData))?;
        let body = redact_data(&parsed);
        let obj = body
            .as_object()
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let trunk =
            bounded_text(obj.get("trunk")).ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let current_branch = bounded_text(obj.get("currentBranch"))
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let raw_branches = obj
            .get("branches")
            .and_then(Value::as_array)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let mut branches = Vec::with_capacity(raw_branches.len());
        for b in raw_branches {
            let bo = b
                .as_object()
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
            let pr = match bo.get("pr") {
                None | Some(Value::Null) => None,
                Some(Value::Object(p)) => Some(LocalBranchPr {
                    number: pos_u64(p.get("number"))
                        .ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
                    url: bounded_text(p.get("url"))
                        .ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
                }),
                _ => return Err(ForgeError::new(Kind::InvalidData)),
            };
            branches.push(ForgeLocalBranch {
                name: bounded_text(bo.get("name"))
                    .ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
                head: bounded_text(bo.get("head"))
                    .ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
                base: bounded_text(bo.get("base"))
                    .ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
                pr,
                is_current: bo
                    .get("isCurrent")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
                is_merged: bo
                    .get("isMerged")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
                is_queued: bo
                    .get("isQueued")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
                needs_rebase: bo
                    .get("needsRebase")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
            });
        }
        Ok((
            ForgeLocalStack {
                trunk,
                current_branch,
                branches,
            },
            body,
        ))
    }

    pub async fn rebase(
        &self,
        action: LocalRebaseAction,
        expected: &ForgeStackExpected,
        stack: &HostStack,
        cancellation: Option<Arc<Cancellation>>,
        allowed: impl Fn() -> bool,
        dispatch: Arc<MutationDispatch>,
    ) -> Result<LocalStackOperation, ForgeError> {
        let (current, _) = self.read(cancellation.clone()).await?;
        let plan_stack = stack.as_plan_stack();
        let Some(ref expected_local) = expected.local else {
            return Err(ForgeError::not_dispatched(Kind::Conflict));
        };
        let branch_ok = if action == LocalRebaseAction::Rebase {
            matches_local_stack(&current, &plan_stack)
        } else {
            matches_stack_branches(&current, &plan_stack)
        };
        if !same_local_stack(expected_local, &current) || !branch_ok {
            return Err(ForgeError::not_dispatched(Kind::Conflict));
        }
        if action != LocalRebaseAction::Abort
            && (!can_publish_stack(&plan_stack)
                || stack.layers.iter().any(|l| l.queue_state.is_some())
                || current.branches.iter().any(|b| b.is_queued))
        {
            return Err(ForgeError::not_dispatched(Kind::Conflict));
        }
        if action == LocalRebaseAction::Rebase {
            let layer_heads: HashMap<u64, &str> = stack
                .layers
                .iter()
                .map(|l| (l.number, l.head_sha.as_str()))
                .collect();
            if current.branches.iter().any(|b| {
                !b.is_merged
                    && b.pr
                        .as_ref()
                        .and_then(|pr| layer_heads.get(&pr.number).copied())
                        != Some(b.head.as_str())
            }) {
                return Err(ForgeError::not_dispatched(Kind::Conflict));
            }
        }
        if action == LocalRebaseAction::Push {
            return self
                .push(
                    expected,
                    &current,
                    &plan_stack,
                    cancellation,
                    allowed,
                    dispatch,
                )
                .await;
        }
        if !allowed() {
            return Err(ForgeError::not_dispatched(Kind::Forbidden));
        }
        let mut args = vec![String::from("stack"), String::from("rebase")];
        if action == LocalRebaseAction::Rebase {
            args.push(String::from("--remote"));
            args.push(String::from("origin"));
        } else {
            args.push(format!("--{}", action.as_str()));
        }
        let mut req = CommandRequest::new(self.command.clone(), args);
        req.mode = Mode::Json;
        req.cancellation = cancellation;
        req.dispatch = Some(dispatch.clone());
        let response = match self.runner.run(req).await {
            Ok(res) => res,
            Err(err) => {
                if !dispatch.dispatched() {
                    dispatch.reject();
                }
                return Err(err);
            }
        };
        if response.identity_changed {
            let mut receipt = Map::new();
            receipt.insert(String::from("dispatched"), Value::Bool(true));
            let mut err = ForgeError::new(Kind::OutcomeUncertain);
            err.receipt = Some(Value::Object(receipt));
            return Err(err);
        }
        if matches!(response.code, Some(3 | 7)) {
            return Ok(LocalStackOperation {
                action: action.as_str().to_owned(),
                state: String::from("conflict"),
                message: String::from(
                    "The local stack rebase needs conflict resolution. Resolve and stage the files, then Continue rebase, or Abort rebase.",
                ),
            });
        }
        if response.code != Some(0) {
            let state = if matches!(response.code, Some(2 | 5 | 9)) {
                "failed"
            } else {
                "uncertain"
            };
            return Ok(LocalStackOperation {
                action: action.as_str().to_owned(),
                state: state.to_owned(),
                message: String::from(
                    "gh stack could not rebase this stack. Check that the extension is installed, the checkout is clean and these branches are available here. No push was attempted.",
                ),
            });
        }
        if action == LocalRebaseAction::Abort {
            return Ok(LocalStackOperation {
                action: String::from("abort"),
                state: String::from("aborted"),
                message: String::from(
                    "gh stack restored the local branches. No push was attempted.",
                ),
            });
        }
        Ok(LocalStackOperation {
            action: action.as_str().to_owned(),
            state: String::from("push_partial"),
            message: STACK_REBASED_LOCALLY.to_owned(),
        })
    }

    pub async fn restack(
        &self,
        step: RestackStep,
        cancellation: Option<Arc<Cancellation>>,
        allowed: impl Fn() -> bool,
    ) -> Result<&'static str, ForgeError> {
        if !allowed() {
            return Err(ForgeError::not_dispatched(Kind::Forbidden));
        }
        let mut args = vec![String::from("stack"), String::from("rebase")];
        match step {
            RestackStep::Upstack => {
                args.push(String::from("--upstack"));
                args.push(String::from("--remote"));
                args.push(String::from("origin"));
            }
            RestackStep::Continue => args.push(String::from("--continue")),
            RestackStep::Abort => args.push(String::from("--abort")),
        }
        let mut req = CommandRequest::new(self.command.clone(), args);
        req.mode = Mode::Json;
        req.cancellation = cancellation;
        let response = self.runner.run(req).await?;
        Ok(match response.code {
            Some(0) => "restacked",
            Some(3 | 7) => "conflict",
            Some(2 | 5 | 9) => "failed",
            _ => "uncertain",
        })
    }

    async fn push(
        &self,
        reviewed: &ForgeStackExpected,
        local: &ForgeLocalStack,
        stack: &PlanStack,
        cancellation: Option<Arc<Cancellation>>,
        allowed: impl Fn() -> bool,
        dispatch: Arc<MutationDispatch>,
    ) -> Result<LocalStackOperation, ForgeError> {
        let Some(ref publisher) = self.publisher else {
            return Err(ForgeError::not_dispatched(Kind::Unsupported));
        };
        let updates = plan_stack_publication(reviewed, local, stack)
            .map_err(|_| ForgeError::not_dispatched(Kind::Conflict))?;
        if !allowed() {
            return Err(ForgeError::not_dispatched(Kind::Forbidden));
        }
        let spec = StackPushSpec {
            remote: String::from("origin"),
            updates: updates
                .iter()
                .map(|u| StackPushRefUpdate {
                    git_ref: format!("refs/heads/{}", u.branch),
                    lease: u.lease.clone(),
                    target: u.target.clone(),
                })
                .collect(),
        };
        let d_hook = dispatch.clone();
        let report = match publisher
            .publish(
                spec,
                cancellation,
                Box::new(move || {
                    d_hook.record();
                }),
            )
            .await
        {
            Ok(report) => report,
            Err(err) => {
                if !dispatch.dispatched() {
                    dispatch.reject();
                }
                return Err(err);
            }
        };
        Ok(publish_outcome(
            &updates,
            stack_publish_result(&updates, &report),
        ))
    }
}

fn publish_outcome(updates: &[StackPublishUpdate], result: PublishOutcome) -> LocalStackOperation {
    let layers = updates
        .iter()
        .map(|u| format!("#{}", u.number))
        .collect::<Vec<_>>()
        .join(", ");
    match result {
        PublishOutcome::Published => LocalStackOperation {
            action: String::from("push"),
            state: String::from("rebased"),
            message: format!("Published {layers} to GitHub."),
        },
        PublishOutcome::Refused => LocalStackOperation {
            action: String::from("push"),
            state: String::from("failed"),
            message: format!(
                "GitHub refused the push, or a layer changed after review. Nothing was published to {layers}. Bring GitHub's newer commits into the stack, then publish again."
            ),
        },
        PublishOutcome::Unknown => LocalStackOperation {
            action: String::from("push"),
            state: String::from("uncertain"),
            message: String::from(
                "Git did not confirm the push. Refresh the stack to compare GitHub with the published revisions. Publishing again is safe; leases stop any overwrite.",
            ),
        },
    }
}
