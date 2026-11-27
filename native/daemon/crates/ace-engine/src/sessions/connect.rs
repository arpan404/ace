// SPDX-License-Identifier: Apache-2.0

use std::rc::Rc;

use crate::sessions::attach::{OpenFailure, OpenRequest, OpenSteps};
use crate::sessions::open_session::{OpenRefusal, OpenView};
use crate::{Core, EngineError};

/// Open the thread's stored binding through the Rust provider opener.
pub(crate) async fn stored(core: &Rc<Core>, thread: &str) -> Result<(), OpenFailure> {
    crate::recovery::blob_cleanup::before_dispatch(core, thread)
        .await
        .map_err(attach_error)?;
    crate::recovery::session_bound::before_dispatch(core, thread)
        .await
        .map_err(attach_error)?;
    let metadata = super::metadata::session(&core.store, thread).map_err(attach_error)?;
    let row = crate::recovery::threads::get(&core.store, thread)
        .map_err(attach_error)?
        .ok_or(OpenFailure::Refused(OpenRefusal::Deleted))?;
    let view = core
        .with_state(|state| OpenView {
            continuation: row.provider == "cursor"
                && metadata.backend.as_deref() != Some("cursor-sdk"),
            workspace_ready: metadata.workspace_ready,
            session_attached: state.sessions.attached.contains_key(thread),
            access_unchanged: true,
            opening: state.session_opening(thread),
            ..OpenView::default()
        })
        .map_err(attach_error)?;
    check(core, thread, &metadata.cwd).map_err(OpenFailure::Refused)?;
    let opener = core
        .with_state(|state| state.sessions.opener.clone())
        .map_err(attach_error)?
        .ok_or_else(|| OpenFailure::Provider("Rust session opener is unavailable".to_owned()))?;
    crate::actor::get_or_create(core, &thread.to_owned()).map_err(attach_error)?;
    let recheck = || check(core, thread, &metadata.cwd);
    let writable = || {
        let live = core.actor_deps.borrow().live.clone();
        live.writable()
    };
    let generation = core
        .with_state(|state| state.store_generation(&core.store, thread))
        .map_err(attach_error)?
        .map_err(attach_error)?;
    let request = OpenRequest {
        thread_id: thread.to_owned(),
        provider: row.provider,
        cwd: metadata.cwd.clone(),
        model: metadata.model,
        instance_id: metadata.instance_id,
        backend: metadata.backend,
        resume_native_session_id: metadata.native_session_id,
        store_generation: u64::try_from(generation).ok(),
        ..OpenRequest::default()
    };
    super::attach::open(
        core,
        opener.as_ref(),
        request,
        &OpenSteps {
            view: &view,
            prepare_workspace: None,
            writable: Some(&writable),
            recheck: Some(&recheck),
        },
    )
    .await
}

fn attach_error(error: EngineError) -> OpenFailure {
    OpenFailure::Attach(error.to_string())
}

fn check(core: &Core, id: &str, cwd: &str) -> Result<(), OpenRefusal> {
    if core.closing.get() {
        return Err(OpenRefusal::Closing);
    }
    let (cleaning, closing) = core
        .with_state(|state| (state.repo.cleaning(id), state.sessions.is_closing(id)))
        .map_err(|_| OpenRefusal::Closing)?;
    if cleaning {
        return Err(OpenRefusal::Cleaning);
    }
    if closing {
        return Err(OpenRefusal::Closing);
    }
    let fenced = crate::queue::worker::fenced(core, id)
        .and_then(|fenced| {
            if fenced {
                Ok(true)
            } else {
                crate::queue::worker::workspace_reserved(core, cwd)
            }
        })
        .map_err(|_| OpenRefusal::Fenced)?;
    if fenced {
        return Err(OpenRefusal::Fenced);
    }
    let row = crate::recovery::threads::get(&core.store, id).map_err(|_| OpenRefusal::Deleted)?;
    if row.is_none_or(|row| row.client.get("deletedAt").is_some_and(|at| !at.is_null())) {
        return Err(OpenRefusal::Deleted);
    }
    Ok(())
}
