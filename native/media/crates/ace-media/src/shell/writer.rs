// SPDX-License-Identifier: Apache-2.0
//! One task per outbound lane, so a slow reader of one lane never holds up another.
use std::time::Duration;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

pub struct Writer {
    tx: mpsc::UnboundedSender<Vec<u8>>,
    task: JoinHandle<()>,
}

impl Writer {
    pub fn spawn<W: AsyncWrite + Unpin + Send + 'static>(mut sink: W) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let task = tokio::spawn(async move {
            while let Some(bytes) = rx.recv().await {
                if sink.write_all(&bytes).await.is_err() || sink.flush().await.is_err() {
                    return;
                }
            }
        });
        Self { tx, task }
    }

    pub fn send(&self, bytes: Vec<u8>) {
        let _ = self.tx.send(bytes);
    }

    /// Writes what is queued, waiting at most `within`.
    pub async fn close(self, within: Duration) {
        drop(self.tx);
        let _ = tokio::time::timeout(within, self.task).await;
    }
}
