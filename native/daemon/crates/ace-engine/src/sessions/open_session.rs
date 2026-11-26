// SPDX-License-Identifier: Apache-2.0
//! `sessions.ts`'s open sequence, before any provider work: the order every entry checks before it
//! opens a session, and the refusal each check returns. The provider call, the workspace
//! preparation and the access resolution are the caller's ports; this module owns the order and
//! words, so every entry refuses the same way.

/// What the open's first steps read about the thread (`openSession`, `sessions.ts:341`-`:361`).
#[derive(Debug, Clone, Default)]
pub struct OpenView {
    /// `repo.store.getThread(id)?.continuation`: a Cursor CLI thread is read-only.
    pub continuation: bool,
    /// The thread is being deleted (`repo.cleaning`).
    pub cleaning: bool,
    /// The engine is closing (`dependencies.closing()`).
    pub closing: bool,
    /// The thread is moving or moved (ADR 0191): no provider opens for it.
    pub fenced: bool,
    /// `getThread(id).deletedAt !== undefined`.
    pub deleted: bool,
    /// The stored session's workspace is ready (`metadata.workspaceReady`).
    pub workspace_ready: bool,
    /// The entry would prepare a workspace from a provider's folder (`prepareWorkspace` bound).
    pub can_prepare_workspace: bool,
    /// A session is already attached.
    pub session_attached: bool,
    /// The attached session's access is still the one the thread runs under.
    pub access_unchanged: bool,
    /// A prepared root starting its first turn, or a turn of ace's own still live.
    pub own_live: bool,
    /// The open already in flight (`beginSessionOpen` set).
    pub opening: bool,
}

/// Why the open stopped before it touched a provider, in the order the TypeScript checks it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenRefusal {
    /// A Cursor CLI thread is read-only; continue in a new thread.
    Continuation,
    /// The thread is being deleted.
    Cleaning,
    /// The thread is moving to another machine (ADR 0191); a held send is never failed for it.
    Fenced,
    /// The thread is closing.
    Closing,
    /// The thread is deleted.
    Deleted,
    /// A worktree must be made now, and this engine has no preparation port.
    WorkspaceUnavailable,
}

impl OpenRefusal {
    /// The error text the TypeScript throws for this refusal.
    pub fn message(&self) -> &'static str {
        match self {
            OpenRefusal::Continuation => {
                "Cursor CLI threads are read-only; continue in a new thread"
            }
            OpenRefusal::Cleaning => "Thread is being deleted",
            OpenRefusal::Fenced => {
                "This thread is moving to another machine; nothing more runs here"
            }
            OpenRefusal::Closing => "Thread is closing",
            OpenRefusal::Deleted => "Thread deleted",
            OpenRefusal::WorkspaceUnavailable => "Worktree preparation unavailable",
        }
    }
}

/// What the open should do after the first checks: nothing (a session already serves the thread),
/// or go on and open one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenStep {
    /// A session is attached and its access still matches: settle it, open nothing.
    AlreadyOpen,
    /// The open is already in flight: join it, start nothing.
    InFlight,
    /// Go on: prepare the workspace if needed, then open the provider.
    Proceed,
    /// Go on, preparing the workspace first.
    PrepareWorkspace,
}

/// The first steps of `openSession`: every refusal in the TypeScript's order, then what is left.
pub fn first_step(view: &OpenView) -> Result<OpenStep, OpenRefusal> {
    if view.continuation {
        return Err(OpenRefusal::Continuation);
    }
    if view.cleaning {
        return Err(OpenRefusal::Cleaning);
    }
    if view.fenced {
        return Err(OpenRefusal::Fenced);
    }
    if view.closing {
        return Err(OpenRefusal::Closing);
    }
    if view.deleted {
        return Err(OpenRefusal::Deleted);
    }
    if view.opening {
        return Ok(OpenStep::InFlight);
    }
    if view.session_attached && (view.access_unchanged || view.own_live) {
        return Ok(OpenStep::AlreadyOpen);
    }
    if !view.workspace_ready {
        if !view.can_prepare_workspace {
            return Err(OpenRefusal::WorkspaceUnavailable);
        }
        return Ok(OpenStep::PrepareWorkspace);
    }
    Ok(OpenStep::Proceed)
}

#[cfg(test)]
mod tests;
