// SPDX-License-Identifier: Apache-2.0
//! Limits for producers that haven't proven themselves yet: how many may connect at once, and
//! how many bytes one may send before its hello is accepted.
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll, ready};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// A slot under a cap; dropping it frees the slot.
pub struct Slot(Arc<AtomicUsize>);

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

/// A counter with a cap, shared by every listener.
#[derive(Clone)]
pub struct Cap {
    count: Arc<AtomicUsize>,
    max: usize,
}

impl Cap {
    pub fn new(max: usize) -> Self {
        Self {
            count: Arc::default(),
            max,
        }
    }

    pub fn take(&self) -> Option<Slot> {
        self.count
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < self.max).then_some(n + 1)
            })
            .ok()
            .map(|_| Slot(self.count.clone()))
    }
}

/// A stream that reads at most `left` bytes until lifted; past that, reading fails.
pub struct Budget<S> {
    inner: S,
    left: usize,
}

impl<S> Budget<S> {
    pub fn new(inner: S, left: usize) -> Self {
        Self { inner, left }
    }

    /// The producer is admitted: no more limit.
    pub fn lift(&mut self) {
        self.left = usize::MAX;
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Budget<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.left == 0 {
            return Poll::Ready(Err(io::Error::other(
                "pre-authentication byte budget spent",
            )));
        }
        let max = buf.remaining().min(this.left);
        let mut limited = ReadBuf::new(buf.initialize_unfilled_to(max));
        ready!(Pin::new(&mut this.inner).poll_read(cx, &mut limited))?;
        let n = limited.filled().len();
        buf.advance(n);
        if this.left != usize::MAX {
            this.left -= n;
        }
        Poll::Ready(Ok(()))
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Budget<S> {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, b: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, b)
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn a_cap_hands_out_only_its_slots_and_takes_them_back() {
        let cap = Cap::new(2);
        let a = cap.take();
        let b = cap.take();
        assert!(a.is_some() && b.is_some());
        assert!(cap.take().is_none());
        drop(a);
        assert!(cap.take().is_some());
    }

    #[test]
    fn reading_past_the_budget_fails_until_it_is_lifted() {
        let runtime = match tokio::runtime::Builder::new_current_thread().build() {
            Ok(runtime) => runtime,
            Err(error) => panic!("runtime: {error}"),
        };
        runtime.block_on(async {
            let (mut tx, rx) = tokio::io::duplex(64);
            let _ = tx.write_all(&[1; 20]).await;
            let mut budget = Budget::new(rx, 8);
            let mut buf = [0u8; 20];
            assert!(matches!(budget.read(&mut buf).await, Ok(8)));
            assert!(budget.read(&mut buf).await.is_err());
            budget.lift();
            assert!(matches!(budget.read(&mut buf).await, Ok(12)));
        });
    }
}
