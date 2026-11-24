//! A permit follows file work onto the blocking pool, where aborting its waiter cannot stop it.

use std::future::Future;
use std::sync::Arc;

use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinHandle;

tokio::task_local! {
    static PERMIT: Arc<OwnedSemaphorePermit>;
}

pub(crate) async fn acquire(budget: &Arc<Semaphore>) -> Option<Arc<OwnedSemaphorePermit>> {
    if let Ok(permit) = PERMIT.try_with(Arc::clone) {
        return Some(permit);
    }
    budget.clone().acquire_owned().await.ok().map(Arc::new)
}

pub(crate) fn with<T>(
    permit: Arc<OwnedSemaphorePermit>,
    future: impl Future<Output = T>,
) -> impl Future<Output = T> {
    PERMIT.scope(permit, future)
}

pub(crate) fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> JoinHandle<T> {
    let permit = PERMIT.try_with(Arc::clone).ok();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        work()
    })
}
