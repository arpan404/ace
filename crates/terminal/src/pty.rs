use crate::{Result, TerminalConfig, TerminalError};
use async_trait::async_trait;
use std::path::PathBuf;
use tokio::sync::mpsc;

#[derive(Debug, Clone)]
pub struct PtySpawnRequest {
    pub cwd: PathBuf,
    pub cols: u16,
    pub rows: u16,
    pub env: Vec<(String, String)>,
}

#[derive(Debug)]
pub enum PtyEvent {
    Output(Vec<u8>),
    Exit {
        exit_code: Option<i32>,
        exit_signal: Option<i32>,
    },
    Error(String),
}

#[derive(Debug)]
pub enum PtyControl {
    Resize { cols: u16, rows: u16 },
    Kill,
}

#[derive(Debug)]
pub struct PtyHandle {
    pid: Option<u32>,
    write_tx: mpsc::Sender<Vec<u8>>,
    control_tx: mpsc::Sender<PtyControl>,
}

impl PtyHandle {
    #[must_use]
    pub fn new(
        pid: Option<u32>,
        write_tx: mpsc::Sender<Vec<u8>>,
        control_tx: mpsc::Sender<PtyControl>,
    ) -> Self {
        Self {
            pid,
            write_tx,
            control_tx,
        }
    }

    #[must_use]
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    pub async fn write(&self, data: Vec<u8>) -> Result<()> {
        self.write_tx
            .send(data)
            .await
            .map_err(|_| TerminalError::ChannelClosed)
    }

    pub async fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.control_tx
            .send(PtyControl::Resize { cols, rows })
            .await
            .map_err(|_| TerminalError::ChannelClosed)
    }

    pub async fn kill(&self) -> Result<()> {
        self.control_tx
            .send(PtyControl::Kill)
            .await
            .map_err(|_| TerminalError::ChannelClosed)
    }
}

#[async_trait]
pub trait PtyAdapter: Send + Sync + 'static {
    async fn spawn(
        &self,
        request: PtySpawnRequest,
        events: mpsc::Sender<PtyEvent>,
        config: &TerminalConfig,
    ) -> Result<PtyHandle>;
}
