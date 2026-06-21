use crate::{
    PortablePtyAdapter, PtyAdapter, PtyEvent, PtySpawnRequest, Result, SequencedTerminalEvent,
    TerminalClearRequest, TerminalCloseRequest, TerminalConfig, TerminalEvent, TerminalListRequest,
    TerminalOpenRequest, TerminalProcessSummary, TerminalResizeRequest, TerminalRestartRequest,
    TerminalSessionSnapshot, TerminalSessionStatus, TerminalSubscribeRequest,
    TerminalTerminateRequest, TerminalWriteRequest, append_bounded_history,
    config::{DEFAULT_COLS, DEFAULT_ROWS, MAX_WRITE_BYTES},
    session::{SessionKey, TerminalSession},
    time::now_iso,
    validation::{
        title_from_input, validate_cols, validate_cwd, validate_env, validate_rows,
        validate_terminal_id, validate_thread_id,
    },
};
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::sync::{Mutex, RwLock, broadcast, mpsc};
use tracing::{debug, warn};

pub struct TerminalManager<A: PtyAdapter = PortablePtyAdapter> {
    pub(crate) adapter: Arc<A>,
    config: TerminalConfig,
    sessions: Arc<RwLock<HashMap<SessionKey, Arc<TerminalSession>>>>,
    events: broadcast::Sender<SequencedTerminalEvent>,
    replay: Arc<Mutex<VecDeque<SequencedTerminalEvent>>>,
    next_sequence: Arc<AtomicU64>,
}

impl<A: PtyAdapter> Clone for TerminalManager<A> {
    fn clone(&self) -> Self {
        Self {
            adapter: Arc::clone(&self.adapter),
            config: self.config.clone(),
            sessions: Arc::clone(&self.sessions),
            events: self.events.clone(),
            replay: Arc::clone(&self.replay),
            next_sequence: Arc::clone(&self.next_sequence),
        }
    }
}

impl TerminalManager<PortablePtyAdapter> {
    #[must_use]
    pub fn production() -> Self {
        Self::new(PortablePtyAdapter)
    }
}

impl<A: PtyAdapter> TerminalManager<A> {
    #[must_use]
    pub fn new(adapter: A) -> Self {
        Self::with_config(adapter, TerminalConfig::default())
    }

    #[must_use]
    pub fn with_config(adapter: A, config: TerminalConfig) -> Self {
        let (events, _) = broadcast::channel(config.event_replay_limit.max(16));
        Self {
            adapter: Arc::new(adapter),
            config,
            sessions: Arc::new(RwLock::new(HashMap::new())),
            events,
            replay: Arc::new(Mutex::new(VecDeque::new())),
            next_sequence: Arc::new(AtomicU64::new(1)),
        }
    }

    pub async fn open(&self, request: TerminalOpenRequest) -> Result<TerminalSessionSnapshot> {
        let thread_id = validate_thread_id(request.thread_id)?;
        let terminal_id = validate_terminal_id(request.terminal_id)?;
        let cwd = validate_cwd(&request.cwd)?;
        let cols = validate_cols(request.cols.unwrap_or(DEFAULT_COLS))?;
        let rows = validate_rows(request.rows.unwrap_or(DEFAULT_ROWS))?;
        let env = validate_env(request.env.unwrap_or_default())?;
        let key = SessionKey::new(thread_id.clone(), terminal_id.clone());

        let session = {
            let mut sessions = self.sessions.write().await;
            Arc::clone(sessions.entry(key).or_insert_with(|| {
                Arc::new(TerminalSession::new(
                    thread_id,
                    terminal_id,
                    cwd.clone(),
                    cols,
                    rows,
                ))
            }))
        };

        let restart_needed = {
            let state = session.state.lock().await;
            state.cwd != cwd.to_string_lossy() || state.status != TerminalSessionStatus::Running
        };
        if restart_needed {
            self.start_session(Arc::clone(&session), cwd, cols, rows, env, false)
                .await?;
        } else {
            self.resize_session(&session, cols, rows).await?;
        }
        Ok(session
            .snapshot(self.next_sequence.load(Ordering::Relaxed))
            .await)
    }

    pub async fn write(&self, request: TerminalWriteRequest) -> Result<()> {
        let (session, terminal_id) = self
            .require_session(request.thread_id, request.terminal_id)
            .await?;
        let bytes = request.data.into_bytes();
        if bytes.is_empty() || bytes.len() > MAX_WRITE_BYTES {
            return Err(crate::TerminalError::InvalidInput(format!(
                "write must be 1..={MAX_WRITE_BYTES} bytes"
            )));
        }
        if let Some(title) = title_from_input(&bytes) {
            let event = {
                let mut state = session.state.lock().await;
                if state.title.as_deref() == Some(title.as_str()) {
                    None
                } else {
                    state.title = Some(title.clone());
                    state.updated_at = now_iso();
                    Some(TerminalEvent::Title {
                        thread_id: state.thread_id.clone(),
                        terminal_id: terminal_id.clone(),
                        created_at: now_iso(),
                        title: Some(title),
                    })
                }
            };
            if let Some(event) = event {
                self.publish(event).await;
            }
        }
        let handle = session.handle.lock().await;
        let Some(handle) = handle.as_ref() else {
            return Err(crate::TerminalError::NotRunning {
                thread_id: session.thread_id().await,
                terminal_id,
            });
        };
        handle.write(bytes).await
    }

    pub async fn resize(&self, request: TerminalResizeRequest) -> Result<()> {
        let (session, _) = self
            .require_session(request.thread_id, request.terminal_id)
            .await?;
        let cols = validate_cols(request.cols)?;
        let rows = validate_rows(request.rows)?;
        self.resize_session(&session, cols, rows).await
    }

    pub async fn clear(&self, request: TerminalClearRequest) -> Result<()> {
        let (session, terminal_id) = self
            .require_session(request.thread_id, request.terminal_id)
            .await?;
        let event = {
            let mut state = session.state.lock().await;
            state.history.clear();
            state.title = None;
            state.updated_at = now_iso();
            TerminalEvent::Cleared {
                thread_id: state.thread_id.clone(),
                terminal_id,
                created_at: now_iso(),
            }
        };
        self.publish(event).await;
        Ok(())
    }

    pub async fn restart(
        &self,
        request: TerminalRestartRequest,
    ) -> Result<TerminalSessionSnapshot> {
        let thread_id = validate_thread_id(request.thread_id)?;
        let terminal_id = validate_terminal_id(request.terminal_id)?;
        let cwd = validate_cwd(&request.cwd)?;
        let cols = validate_cols(request.cols)?;
        let rows = validate_rows(request.rows)?;
        let env = validate_env(request.env.unwrap_or_default())?;
        let key = SessionKey::new(thread_id.clone(), terminal_id.clone());
        let session = {
            let mut sessions = self.sessions.write().await;
            Arc::clone(sessions.entry(key).or_insert_with(|| {
                Arc::new(TerminalSession::new(
                    thread_id,
                    terminal_id,
                    cwd.clone(),
                    cols,
                    rows,
                ))
            }))
        };
        self.start_session(Arc::clone(&session), cwd, cols, rows, env, true)
            .await?;
        Ok(session
            .snapshot(self.next_sequence.load(Ordering::Relaxed))
            .await)
    }

    pub async fn close(&self, request: TerminalCloseRequest) -> Result<()> {
        let thread_id = validate_thread_id(request.thread_id)?;
        let keys = {
            let sessions = self.sessions.read().await;
            sessions
                .keys()
                .filter(|key| {
                    key.thread_id == thread_id
                        && request
                            .terminal_id
                            .as_ref()
                            .is_none_or(|terminal_id| &key.terminal_id == terminal_id)
                })
                .cloned()
                .collect::<Vec<_>>()
        };
        for key in keys {
            let session = self.sessions.write().await.remove(&key);
            if let Some(session) = session {
                self.stop_session(&session).await?;
                if request.delete_history {
                    session.state.lock().await.history.clear();
                }
            }
        }
        Ok(())
    }

    pub async fn list(&self, request: TerminalListRequest) -> Result<Vec<TerminalProcessSummary>> {
        let sessions = self.sessions.read().await;
        let mut summaries = Vec::with_capacity(sessions.len());
        for session in sessions.values() {
            let state = session.state.lock().await;
            if request
                .thread_id
                .as_ref()
                .is_some_and(|thread_id| thread_id != &state.thread_id)
            {
                continue;
            }
            if request.running_only.unwrap_or(true)
                && state.status != TerminalSessionStatus::Running
            {
                continue;
            }
            summaries.push(state.summary());
        }
        summaries.sort_by(|left, right| {
            left.thread_id
                .cmp(&right.thread_id)
                .then(left.terminal_id.cmp(&right.terminal_id))
        });
        Ok(summaries)
    }

    pub async fn terminate(
        &self,
        request: TerminalTerminateRequest,
    ) -> Result<TerminalSessionSnapshot> {
        let (session, terminal_id) = self
            .require_session(request.thread_id, request.terminal_id)
            .await?;
        self.stop_session(&session).await?;
        let event = {
            let state = session.state.lock().await;
            TerminalEvent::Exited {
                thread_id: state.thread_id.clone(),
                terminal_id,
                created_at: now_iso(),
                exit_code: None,
                exit_signal: None,
            }
        };
        self.publish(event).await;
        Ok(session
            .snapshot(self.next_sequence.load(Ordering::Relaxed))
            .await)
    }

    pub async fn subscribe(&self, request: TerminalSubscribeRequest) -> TerminalSubscription {
        let requested_after = request.from_sequence_exclusive.unwrap_or(0);
        let replay = self.filtered_replay(&request).await;
        TerminalSubscription {
            request,
            requested_after,
            replay: VecDeque::from(replay),
            receiver: self.events.subscribe(),
        }
    }

    async fn filtered_replay(
        &self,
        request: &TerminalSubscribeRequest,
    ) -> Vec<SequencedTerminalEvent> {
        let from = request.from_sequence_exclusive.unwrap_or(0);
        self.replay
            .lock()
            .await
            .iter()
            .filter(|event| event.sequence > from && event_matches(request, &event.event))
            .cloned()
            .collect()
    }

    async fn start_session(
        &self,
        session: Arc<TerminalSession>,
        cwd: PathBuf,
        cols: u16,
        rows: u16,
        env: Vec<(String, String)>,
        restarted: bool,
    ) -> Result<()> {
        self.stop_session(&session).await.ok();
        let (event_tx, event_rx) =
            mpsc::channel::<PtyEvent>(self.config.event_replay_limit.max(16));
        let handle = self
            .adapter
            .spawn(
                PtySpawnRequest {
                    cwd: cwd.clone(),
                    cols,
                    rows,
                    env,
                },
                event_tx,
                &self.config,
            )
            .await?;

        {
            let mut state = session.state.lock().await;
            state.cwd = cwd.to_string_lossy().to_string();
            state.cols = cols;
            state.rows = rows;
            state.status = TerminalSessionStatus::Running;
            state.pid = handle.pid();
            state.exit_code = None;
            state.exit_signal = None;
            state.history.clear();
            state.updated_at = now_iso();
        }
        *session.handle.lock().await = Some(handle);

        let snapshot = session
            .snapshot(self.next_sequence.load(Ordering::Relaxed))
            .await;
        let event = if restarted {
            TerminalEvent::Restarted {
                thread_id: snapshot.thread_id.clone(),
                terminal_id: snapshot.terminal_id.clone(),
                created_at: now_iso(),
                snapshot,
            }
        } else {
            TerminalEvent::Started {
                thread_id: snapshot.thread_id.clone(),
                terminal_id: snapshot.terminal_id.clone(),
                created_at: now_iso(),
                snapshot,
            }
        };
        self.publish(event).await;
        self.spawn_event_drain(session, event_rx);
        Ok(())
    }

    fn spawn_event_drain(&self, session: Arc<TerminalSession>, mut rx: mpsc::Receiver<PtyEvent>) {
        let manager = self.clone();
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    PtyEvent::Output(data) => {
                        let mut data = data;
                        while data.len() < manager.config.output_batch_bytes {
                            match tokio::time::timeout(manager.config.output_batch_delay, rx.recv())
                                .await
                            {
                                Ok(Some(PtyEvent::Output(next))) => data.extend_from_slice(&next),
                                Ok(Some(other)) => {
                                    manager.flush_output(&session, data).await;
                                    manager.handle_pty_event(&session, other).await;
                                    data = Vec::new();
                                    break;
                                }
                                Ok(None) | Err(_) => break,
                            }
                        }
                        if !data.is_empty() {
                            manager.flush_output(&session, data).await;
                        }
                    }
                    other => manager.handle_pty_event(&session, other).await,
                }
            }
        });
    }

    async fn flush_output(&self, session: &TerminalSession, data: Vec<u8>) {
        let text = String::from_utf8_lossy(&data).to_string();
        let event = {
            let mut state = session.state.lock().await;
            append_bounded_history(&mut state.history, &text, &self.config);
            state.updated_at = now_iso();
            TerminalEvent::Output {
                thread_id: state.thread_id.clone(),
                terminal_id: state.terminal_id.clone(),
                created_at: now_iso(),
                data: text,
            }
        };
        self.publish(event).await;
    }

    async fn handle_pty_event(&self, session: &TerminalSession, event: PtyEvent) {
        match event {
            PtyEvent::Output(data) => self.flush_output(session, data).await,
            PtyEvent::Exit {
                exit_code,
                exit_signal,
            } => {
                let event = {
                    let mut state = session.state.lock().await;
                    if state.status == TerminalSessionStatus::Exited {
                        return;
                    }
                    state.status = TerminalSessionStatus::Exited;
                    state.pid = None;
                    state.exit_code = exit_code;
                    state.exit_signal = exit_signal;
                    state.updated_at = now_iso();
                    TerminalEvent::Exited {
                        thread_id: state.thread_id.clone(),
                        terminal_id: state.terminal_id.clone(),
                        created_at: now_iso(),
                        exit_code,
                        exit_signal,
                    }
                };
                *session.handle.lock().await = None;
                self.publish(event).await;
            }
            PtyEvent::Error(message) => {
                let event = {
                    let mut state = session.state.lock().await;
                    state.status = TerminalSessionStatus::Error;
                    state.pid = None;
                    state.updated_at = now_iso();
                    TerminalEvent::Error {
                        thread_id: state.thread_id.clone(),
                        terminal_id: state.terminal_id.clone(),
                        created_at: now_iso(),
                        message,
                    }
                };
                *session.handle.lock().await = None;
                self.publish(event).await;
            }
        }
    }

    async fn resize_session(&self, session: &TerminalSession, cols: u16, rows: u16) -> Result<()> {
        {
            let mut state = session.state.lock().await;
            state.cols = cols;
            state.rows = rows;
            state.updated_at = now_iso();
        }
        let handle = session.handle.lock().await;
        let Some(handle) = handle.as_ref() else {
            return Ok(());
        };
        handle.resize(cols, rows).await
    }

    async fn stop_session(&self, session: &TerminalSession) -> Result<()> {
        let handle = session.handle.lock().await.take();
        if let Some(handle) = handle {
            handle.kill().await.ok();
        }
        let mut state = session.state.lock().await;
        if state.status == TerminalSessionStatus::Running {
            state.status = TerminalSessionStatus::Exited;
            state.pid = None;
            state.updated_at = now_iso();
        }
        Ok(())
    }

    async fn require_session(
        &self,
        thread_id: String,
        terminal_id: String,
    ) -> Result<(Arc<TerminalSession>, String)> {
        let thread_id = validate_thread_id(thread_id)?;
        let terminal_id = validate_terminal_id(terminal_id)?;
        let key = SessionKey::new(thread_id.clone(), terminal_id.clone());
        let session = self
            .sessions
            .read()
            .await
            .get(&key)
            .cloned()
            .ok_or_else(|| crate::TerminalError::SessionNotFound {
                thread_id,
                terminal_id: terminal_id.clone(),
            })?;
        Ok((session, terminal_id))
    }

    async fn publish(&self, event: TerminalEvent) {
        let sequence = self.next_sequence.fetch_add(1, Ordering::Relaxed);
        let event = SequencedTerminalEvent { sequence, event };
        {
            let mut replay = self.replay.lock().await;
            replay.push_back(event.clone());
            while replay.len() > self.config.event_replay_limit {
                replay.pop_front();
            }
        }
        if self.events.send(event).is_err() {
            debug!("terminal event published without subscribers");
        }
    }
}

pub struct TerminalSubscription {
    request: TerminalSubscribeRequest,
    requested_after: u64,
    replay: VecDeque<SequencedTerminalEvent>,
    receiver: broadcast::Receiver<SequencedTerminalEvent>,
}

impl TerminalSubscription {
    pub async fn next(&mut self) -> Option<SequencedTerminalEvent> {
        if let Some(event) = self.replay.pop_front() {
            return Some(event);
        }
        loop {
            match self.receiver.recv().await {
                Ok(event)
                    if event.sequence > self.requested_after
                        && event_matches(&self.request, &event.event) =>
                {
                    return Some(event);
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    warn!(skipped, "terminal subscriber lagged");
                    return Some(SequencedTerminalEvent {
                        sequence: self.requested_after,
                        event: TerminalEvent::ReplayGap {
                            thread_id: self.request.thread_id.clone(),
                            terminal_id: self.request.terminal_id.clone(),
                            created_at: now_iso(),
                            requested_after: self.requested_after,
                            earliest_available: self.requested_after + skipped,
                        },
                    });
                }
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    }
}

fn event_matches(request: &TerminalSubscribeRequest, event: &TerminalEvent) -> bool {
    let (thread_id, terminal_id) = event_identity(event);
    request
        .thread_id
        .as_ref()
        .is_none_or(|filter| thread_id == Some(filter))
        && request
            .terminal_id
            .as_ref()
            .is_none_or(|filter| terminal_id == Some(filter))
}

fn event_identity(event: &TerminalEvent) -> (Option<&String>, Option<&String>) {
    match event {
        TerminalEvent::Started {
            thread_id,
            terminal_id,
            ..
        }
        | TerminalEvent::Output {
            thread_id,
            terminal_id,
            ..
        }
        | TerminalEvent::Title {
            thread_id,
            terminal_id,
            ..
        }
        | TerminalEvent::Exited {
            thread_id,
            terminal_id,
            ..
        }
        | TerminalEvent::Error {
            thread_id,
            terminal_id,
            ..
        }
        | TerminalEvent::Cleared {
            thread_id,
            terminal_id,
            ..
        }
        | TerminalEvent::Restarted {
            thread_id,
            terminal_id,
            ..
        }
        | TerminalEvent::Activity {
            thread_id,
            terminal_id,
            ..
        } => (Some(thread_id), Some(terminal_id)),
        TerminalEvent::ReplayGap {
            thread_id,
            terminal_id,
            ..
        } => (thread_id.as_ref(), terminal_id.as_ref()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TerminalSessionInput;
    use async_trait::async_trait;
    use std::sync::Mutex as StdMutex;
    use tokio::sync::mpsc;

    #[derive(Default)]
    struct FakePtyAdapter {
        spawns: StdMutex<Vec<mpsc::Sender<PtyEvent>>>,
        controls: StdMutex<Vec<mpsc::Receiver<crate::PtyControl>>>,
        writes: StdMutex<Vec<mpsc::Receiver<Vec<u8>>>>,
    }

    #[async_trait]
    impl PtyAdapter for FakePtyAdapter {
        async fn spawn(
            &self,
            _request: PtySpawnRequest,
            events: mpsc::Sender<PtyEvent>,
            config: &TerminalConfig,
        ) -> Result<crate::PtyHandle> {
            let (write_tx, write_rx) = mpsc::channel(config.write_queue_limit);
            let (control_tx, control_rx) = mpsc::channel(config.control_queue_limit);
            self.spawns.lock().expect("spawns").push(events);
            self.controls.lock().expect("controls").push(control_rx);
            self.writes.lock().expect("writes").push(write_rx);
            Ok(crate::PtyHandle::new(Some(42), write_tx, control_tx))
        }
    }

    #[tokio::test]
    async fn opens_session_and_replays_output() {
        let workspace = tempfile::tempdir().expect("workspace");
        let manager = TerminalManager::new(FakePtyAdapter::default());
        let mut subscription = manager.subscribe(TerminalSubscribeRequest::default()).await;

        let snapshot = manager
            .open(TerminalOpenRequest {
                thread_id: "thread-1".to_string(),
                terminal_id: crate::DEFAULT_TERMINAL_ID.to_string(),
                cwd: workspace.path().to_string_lossy().to_string(),
                cols: None,
                rows: None,
                env: None,
            })
            .await
            .expect("open");

        assert_eq!(snapshot.status, TerminalSessionStatus::Running);
        assert_eq!(snapshot.pid, Some(42));
        let started = subscription.next().await.expect("started");
        assert!(matches!(started.event, TerminalEvent::Started { .. }));

        let sender = manager.adapter.spawns.lock().expect("spawns")[0].clone();
        sender
            .send(PtyEvent::Output(b"hello\n".to_vec()))
            .await
            .expect("send output");
        let output = subscription.next().await.expect("output");
        assert!(
            matches!(output.event, TerminalEvent::Output { ref data, .. } if data == "hello\n")
        );

        let snapshot = manager
            .open(TerminalOpenRequest {
                thread_id: "thread-1".to_string(),
                terminal_id: crate::DEFAULT_TERMINAL_ID.to_string(),
                cwd: workspace.path().to_string_lossy().to_string(),
                cols: None,
                rows: None,
                env: None,
            })
            .await
            .expect("open existing");
        assert_eq!(snapshot.history, "hello\n");
    }

    #[tokio::test]
    async fn write_resize_clear_and_terminate_are_bounded() {
        let workspace = tempfile::tempdir().expect("workspace");
        let manager = TerminalManager::new(FakePtyAdapter::default());
        manager
            .open(TerminalOpenRequest {
                thread_id: "thread-1".to_string(),
                terminal_id: "term".to_string(),
                cwd: workspace.path().to_string_lossy().to_string(),
                cols: Some(80),
                rows: Some(24),
                env: None,
            })
            .await
            .expect("open");

        manager
            .write(TerminalWriteRequest {
                thread_id: "thread-1".to_string(),
                terminal_id: "term".to_string(),
                data: "cargo test\n".to_string(),
            })
            .await
            .expect("write");
        let mut write_rx = manager
            .adapter
            .writes
            .lock()
            .expect("writes")
            .pop()
            .expect("rx");
        assert_eq!(write_rx.recv().await.expect("written"), b"cargo test\n");

        manager
            .resize(TerminalResizeRequest {
                thread_id: "thread-1".to_string(),
                terminal_id: "term".to_string(),
                cols: 100,
                rows: 40,
            })
            .await
            .expect("resize");
        let mut control_rx = manager
            .adapter
            .controls
            .lock()
            .expect("controls")
            .pop()
            .expect("control rx");
        assert!(matches!(
            control_rx.recv().await.expect("resize control"),
            crate::PtyControl::Resize {
                cols: 100,
                rows: 40
            }
        ));

        manager
            .clear(TerminalSessionInput {
                thread_id: "thread-1".to_string(),
                terminal_id: "term".to_string(),
            })
            .await
            .expect("clear");
        let snapshot = manager
            .terminate(TerminalSessionInput {
                thread_id: "thread-1".to_string(),
                terminal_id: "term".to_string(),
            })
            .await
            .expect("terminate");
        assert_eq!(snapshot.status, TerminalSessionStatus::Exited);
        assert!(matches!(
            control_rx.recv().await.expect("kill"),
            crate::PtyControl::Kill
        ));
    }
}
