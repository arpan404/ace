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
pub use win::{in_container, serve};

#[cfg(windows)]
mod win {
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpStream;
    use tokio::sync::watch;

    use spade_sandbox_windows::pipe::{self, PipeSecurity};
    use spade_sandbox_windows::sid::Sid;

    /// The daemon's side: accept pipe connections (only the run's container SID may open the pipe)
    /// and splice each to the TCP proxy on `127.0.0.1:proxy_port`. Returns when `stop` is set.
    pub async fn serve(
        pipe_name: String,
        sid: Sid,
        proxy_port: u16,
        mut stop: watch::Receiver<bool>,
    ) {
        let Ok(security) = PipeSecurity::for_container(&sid) else {
            tracing::warn!("the egress bridge could not build its pipe's permissions");
            return;
        };
        let path = super::pipe_path(&pipe_name);
        let mut first = true;
        loop {
            let Ok(server) = pipe::server(&path, &security, first) else {
                return;
            };
            first = false;
            tokio::select! {
                connected = server.connect() => {
                    if connected.is_err() {
                        continue;
                    }
                }
                _ = stop.changed() => return,
            }
            tokio::spawn(async move {
                let mut server = server;
                if let Ok(mut proxy) = TcpStream::connect(("127.0.0.1", proxy_port)).await {
                    let _ = tokio::io::copy_bidirectional(&mut server, &mut proxy).await;
                    let _ = server.shutdown().await;
                }
            });
        }
    }

    /// The in-container side (`spade sandbox-net-bridge <pipe> <port>`): listen on
    /// `127.0.0.1:<port>` and forward each connection to the daemon's pipe. Blocking; returns a
    /// process exit code.
    pub fn in_container(pipe_name: &str, port: u16) -> u8 {
        let listener = match std::net::TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("sandbox-net-bridge: could not listen on 127.0.0.1:{port}: {error}");
                return 1;
            }
        };
        let path = super::pipe_path(pipe_name);
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let path = path.clone();
            std::thread::spawn(move || splice(stream, &path));
        }
        0
    }

    /// Opens the daemon's pipe and copies bytes both ways between it and `client`.
    fn splice(client: std::net::TcpStream, pipe_path: &str) {
        let pipe = loop {
            match std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(pipe_path)
            {
                Ok(pipe) => break pipe,
                // The daemon makes the next pipe instance lazily; wait briefly and retry.
                Err(error) if error.raw_os_error() == Some(231) => {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                Err(_) => return,
            }
        };
        let mut cr = match client.try_clone() {
            Ok(cr) => cr,
            Err(_) => return,
        };
        let mut cw = client;
        let mut pr = match pipe.try_clone() {
            Ok(pr) => pr,
            Err(_) => return,
        };
        let mut pw = pipe;
        // Command → pipe on one thread; pipe → command here. Each ends when its source does.
        let up = std::thread::spawn(move || {
            let _ = std::io::copy(&mut cr, &mut pw);
        });
        let _ = std::io::copy(&mut pr, &mut cw);
        let _ = cw.shutdown(std::net::Shutdown::Write);
        let _ = up.join();
    }
}
