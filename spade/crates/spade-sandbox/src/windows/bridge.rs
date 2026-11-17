//! The egress bridge that carries a sandboxed run's network to Spade's proxy (ADR 0167
//! decision 3). An AppContainer can't open a loopback connection to a process outside it (the
//! daemon's TCP proxy), but it can open a named pipe whose ACL names its SID, and it can reach a
//! loopback listener inside its own container. So each run gets:
//!
//! - a tiny **bridge** process inside the container ([`in_container`]), listening on
//!   `127.0.0.1:<port>` — what the command's `HTTP_PROXY` points at — forwarding each connection
//!   to the daemon over the named pipe;
//! - the daemon-side **acceptor** ([`serve`]), a pipe server whose DACL grants only the run's
//!   container SID, splicing each pipe connection to the real TCP proxy on loopback.
//!
//! The run's proxy token still rides in `HTTP_PROXY`, so the proxy identifies the run; the bridge
//! and acceptor only move bytes.

/// The full name of a run's egress pipe.
pub fn pipe_path(name: &str) -> String {
    format!(r"\\.\pipe\{name}")
}

#[cfg(windows)]
pub use win::{Stop, in_container, serve};

#[cfg(windows)]
mod win {
    use tokio::io::copy_bidirectional;
    use tokio::net::windows::named_pipe::ClientOptions;
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::watch;

    use spade_sandbox_windows::pipe::{self, PipeSecurity};
    use spade_sandbox_windows::sid::Sid;

    /// Stops a running [`serve`] loop. Cloneable; a drop guard elsewhere calls [`Stop::stop`].
    #[derive(Clone)]
    pub struct Stop(watch::Sender<bool>);

    impl Default for Stop {
        fn default() -> Self {
            Self(watch::Sender::new(false))
        }
    }

    impl Stop {
        pub fn new() -> Self {
            Self::default()
        }

        /// Asks the loop to stop.
        pub fn stop(&self) {
            let _ = self.0.send(true);
        }

        fn watch(&self) -> watch::Receiver<bool> {
            self.0.subscribe()
        }
    }

    /// The daemon's side (async): accept pipe connections — only the run's container SID may open
    /// the pipe — and splice each to the TCP proxy on `127.0.0.1:proxy_port`. Both the server here
    /// and the client in [`in_container`] are overlapped, so a connection's two directions run at
    /// once (a synchronous pipe handle would serialise them and deadlock). Returns when stopped.
    pub async fn serve(pipe_name: &str, sid: &Sid, proxy_port: u16, stop: &Stop) {
        let Ok(security) = PipeSecurity::for_container(sid) else {
            return;
        };
        let path = super::pipe_path(pipe_name);
        let mut stop_rx = stop.watch();
        let mut first = true;
        loop {
            let server = match pipe::server(&path, &security, first) {
                Ok(server) => server,
                Err(_) => return,
            };
            first = false;
            tokio::select! {
                connected = server.connect() => {
                    if connected.is_err() {
                        continue;
                    }
                }
                _ = stop_rx.changed() => return,
            }
            tokio::spawn(async move {
                let mut server = server;
                if let Ok(mut proxy) = TcpStream::connect(("127.0.0.1", proxy_port)).await {
                    let _ = copy_bidirectional(&mut server, &mut proxy).await;
                }
            });
        }
    }

    /// The in-container side (`spade sandbox-net-bridge <pipe> <port>`): listen on
    /// `127.0.0.1:<port>` and forward each connection to the daemon's pipe. Runs its own small
    /// runtime; blocking entry point that returns a process exit code.
    pub fn in_container(pipe_name: &str, port: u16) -> u8 {
        let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        else {
            return 1;
        };
        runtime.block_on(async move {
            let listener = match TcpListener::bind(("127.0.0.1", port)).await {
                Ok(listener) => listener,
                Err(error) => {
                    eprintln!("sandbox-net-bridge: could not listen on 127.0.0.1:{port}: {error}");
                    return 1;
                }
            };
            let path = super::pipe_path(pipe_name);
            loop {
                let Ok((client, _)) = listener.accept().await else {
                    continue;
                };
                let path = path.clone();
                tokio::spawn(async move {
                    if let Some(pipe) = open_pipe(&path).await {
                        let mut client = client;
                        let mut pipe = pipe;
                        let _ = copy_bidirectional(&mut client, &mut pipe).await;
                    }
                });
            }
        })
    }

    /// Opens the daemon's pipe (overlapped), retrying briefly: ERROR_PIPE_BUSY (231) means every
    /// instance is taken, ERROR_FILE_NOT_FOUND (2) means the daemon hasn't made the next instance
    /// yet. Gives up after a couple of seconds so an absent daemon doesn't hang.
    async fn open_pipe(path: &str) -> Option<tokio::net::windows::named_pipe::NamedPipeClient> {
        const PIPE_BUSY: i32 = 231;
        const FILE_NOT_FOUND: i32 = 2;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            match ClientOptions::new().open(path) {
                Ok(pipe) => return Some(pipe),
                Err(error)
                    if matches!(error.raw_os_error(), Some(PIPE_BUSY | FILE_NOT_FOUND))
                        && std::time::Instant::now() < deadline =>
                {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
                Err(_) => return None,
            }
        }
    }
}
