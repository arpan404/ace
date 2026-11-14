// SPDX-License-Identifier: Apache-2.0
//! One task per outbound lane, so a slow reader of one lane never holds up another. Sending
//! never blocks: each lane has a bound on queued bytes, and going past it, or the lane's write
//! failing, ends the process (the supervisor restarts it).
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

/// Queued bytes past which a lane is considered stuck.
pub const NORMAL_LIMIT: usize = 32 * 1024 * 1024;
pub const PRIORITY_LIMIT: usize = 1024 * 1024;

#[derive(Debug)]
pub struct Overflow;

pub struct Writer {
    tx: mpsc::UnboundedSender<Vec<u8>>,
    queued: Arc<AtomicUsize>,
    limit: usize,
    /// Fires when the write task ends, which only happens when a write failed.
    pub failed: oneshot::Receiver<()>,
    task: JoinHandle<()>,
}

impl Writer {
    pub fn spawn<W: AsyncWrite + Unpin + Send + 'static>(mut sink: W, limit: usize) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (dead, failed) = oneshot::channel();
        let queued = Arc::new(AtomicUsize::new(0));
        let counter = queued.clone();
        let task = tokio::spawn(async move {
            while let Some(bytes) = rx.recv().await {
                let written = sink.write_all(&bytes).await.is_ok() && sink.flush().await.is_ok();
                counter.fetch_sub(bytes.len(), Ordering::Relaxed);
                if !written {
                    let _ = dead.send(());
                    return;
                }
            }
        });
        Self {
            tx,
            queued,
            limit,
            failed,
            task,
        }
    }

    pub fn send(&self, bytes: Vec<u8>) -> Result<(), Overflow> {
        let n = bytes.len();
        if self.queued.fetch_add(n, Ordering::Relaxed) + n > self.limit {
            self.queued.fetch_sub(n, Ordering::Relaxed);
            return Err(Overflow);
        }
        self.tx.send(bytes).map_err(|_| Overflow)
    }

    /// Writes what is queued, waiting at most `within`.
    pub async fn close(self, within: Duration) {
        drop(self.tx);
        let _ = tokio::time::timeout(within, self.task).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lane_whose_reader_stops_refuses_more_than_its_bound() {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => panic!("runtime: {error}"),
        };
        runtime.block_on(async {
            // A pipe nobody reads: the first write blocks, later ones queue.
            let (sink, _reader) = tokio::io::duplex(16);
            let writer = Writer::spawn(sink, 1000);
            assert!(writer.send(vec![0; 600]).is_ok());
            assert!(writer.send(vec![0; 300]).is_ok());
            assert!(writer.send(vec![0; 200]).is_err());
        });
    }

    #[test]
    fn a_failed_write_is_reported() {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => panic!("runtime: {error}"),
        };
        runtime.block_on(async {
            let (sink, reader) = tokio::io::duplex(16);
            drop(reader);
            let mut writer = Writer::spawn(sink, 1000);
            assert!(writer.send(vec![0; 10]).is_ok());
            let failed = tokio::time::timeout(Duration::from_secs(2), &mut writer.failed).await;
            assert!(matches!(failed, Ok(Ok(()))));
        });
    }
}
