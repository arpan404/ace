use crate::{
    PtyAdapter, PtyControl, PtyEvent, PtyHandle, PtySpawnRequest, Result, TerminalConfig,
    TerminalError,
};
use async_trait::async_trait;
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use std::{
    env,
    io::{Read, Write},
};
use tokio::sync::mpsc;

#[derive(Debug, Default)]
pub struct PortablePtyAdapter;

#[async_trait]
impl PtyAdapter for PortablePtyAdapter {
    async fn spawn(
        &self,
        request: PtySpawnRequest,
        events: mpsc::Sender<PtyEvent>,
        config: &TerminalConfig,
    ) -> Result<PtyHandle> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: request.rows,
                cols: request.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| TerminalError::Spawn(error.to_string()))?;

        let mut command = CommandBuilder::new(default_shell());
        command.cwd(request.cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        for (key, value) in request.env {
            command.env(key, value);
        }

        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| TerminalError::Spawn(error.to_string()))?;
        let pid = child.process_id();
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| TerminalError::Io(error.to_string()))?;
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|error| TerminalError::Io(error.to_string()))?;
        drop(pair.slave);

        let (write_tx, mut write_rx) = mpsc::channel::<Vec<u8>>(config.write_queue_limit);
        let (control_tx, mut control_rx) = mpsc::channel::<PtyControl>(config.control_queue_limit);

        let read_events = events.clone();
        std::thread::Builder::new()
            .name("ace-terminal-reader".to_string())
            .spawn(move || {
                let mut buffer = [0_u8; 8192];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(read) => {
                            if read_events
                                .blocking_send(PtyEvent::Output(buffer[..read].to_vec()))
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(error) => {
                            let _ = read_events.blocking_send(PtyEvent::Error(error.to_string()));
                            break;
                        }
                    }
                }
                let _ = read_events.blocking_send(PtyEvent::Exit {
                    exit_code: None,
                    exit_signal: None,
                });
            })
            .map_err(|error| TerminalError::Spawn(error.to_string()))?;

        std::thread::Builder::new()
            .name("ace-terminal-writer".to_string())
            .spawn(move || {
                while let Some(data) = write_rx.blocking_recv() {
                    if writer.write_all(&data).is_err() {
                        break;
                    }
                    let _ = writer.flush();
                }
            })
            .map_err(|error| TerminalError::Spawn(error.to_string()))?;

        std::thread::Builder::new()
            .name("ace-terminal-control".to_string())
            .spawn(move || {
                let mut child = child;
                let master = pair.master;
                while let Some(control) = control_rx.blocking_recv() {
                    match control {
                        PtyControl::Resize { cols, rows } => {
                            let _ = master.resize(PtySize {
                                rows,
                                cols,
                                pixel_width: 0,
                                pixel_height: 0,
                            });
                        }
                        PtyControl::Kill => {
                            let _ = child.kill();
                            break;
                        }
                    }
                }
            })
            .map_err(|error| TerminalError::Spawn(error.to_string()))?;

        Ok(PtyHandle::new(pid, write_tx, control_tx))
    }
}

fn default_shell() -> String {
    if cfg!(windows) {
        env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string())
    } else {
        env::var("SHELL").unwrap_or_else(|_| "bash".to_string())
    }
}
