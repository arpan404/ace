// SPDX-License-Identifier: Apache-2.0
//! The encoder page's loopback server. It serves the page at `http://127.0.0.1:<port>/<token>/`
//! (loopback is a secure context, which WebCodecs needs) and accepts the page's two WebSockets,
//! `<token>/in` for pictures and `<token>/out` for chunks, from that origin only. The token is
//! random per browser and reaches Chrome only over its private debugging pipe. Once both
//! sockets are open the listener closes, so nothing else can connect.

use media_codec::CodecError;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};
use tungstenite::WebSocket;
use tungstenite::protocol::{Role, WebSocketConfig};

const PAGE: &str = include_str!("../assets/encoder.html");
/// A request head larger than this is refused.
const MAX_HEAD: usize = 8 * 1024;
/// The longest any one client may take to send its request head.
const HEAD_TIMEOUT: Duration = Duration::from_secs(1);
/// The largest chunk message the page may send: an 8 MiB unit, its description and header.
pub const MAX_CHUNK_MESSAGE: usize = 8 * 1024 * 1024 + 64 * 1024;

pub struct Listener {
    listener: TcpListener,
    token: String,
    port: u16,
}

pub struct Sockets {
    pub input: WebSocket<TcpStream>,
    pub output: WebSocket<TcpStream>,
}

fn backend(error: impl std::fmt::Display) -> CodecError {
    CodecError::Backend(error.to_string())
}

impl Listener {
    pub fn bind() -> Result<Self, CodecError> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(backend)?;
        listener.set_nonblocking(true).map_err(backend)?;
        let port = listener.local_addr().map_err(backend)?.port();
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(backend)?;
        let token = random.iter().map(|byte| format!("{byte:02x}")).collect();
        Ok(Self {
            listener,
            token,
            port,
        })
    }

    pub fn url(&self) -> String {
        format!("{}/{}/", self.origin(), self.token)
    }

    fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Serves the page and waits for both sockets until `deadline`. `alive` stops the wait early
    /// when the browser is already gone.
    pub fn accept(
        self,
        deadline: Instant,
        alive: &dyn Fn() -> bool,
    ) -> Result<Sockets, CodecError> {
        let mut input = None;
        let mut output = None;
        while input.is_none() || output.is_none() {
            if Instant::now() >= deadline {
                return Err(CodecError::DeadlineExceeded);
            }
            if !alive() {
                return Err(CodecError::Backend("Chrome exited while starting".into()));
            }
            let stream = match self.listener.accept() {
                Ok((stream, _)) => stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Err(error) => return Err(backend(error)),
            };
            match self.handle(stream, deadline) {
                Ok(Some((Socket::Input, socket))) => input = Some(socket),
                Ok(Some((Socket::Output, socket))) => output = Some(socket),
                // A page load, a refused request, or a client that went away.
                Ok(None) | Err(_) => {}
            }
        }
        match (input, output) {
            (Some(input), Some(output)) => Ok(Sockets { input, output }),
            _ => Err(CodecError::Backend("encoder page sockets missing".into())),
        }
    }

    fn handle(
        &self,
        mut stream: TcpStream,
        deadline: Instant,
    ) -> Result<Option<(Socket, WebSocket<TcpStream>)>, CodecError> {
        stream.set_nonblocking(false).map_err(backend)?;
        stream.set_nodelay(true).map_err(backend)?;
        // One client gets at most a second, and never past the start-up deadline.
        let until = deadline.min(Instant::now() + HEAD_TIMEOUT);
        let head = read_head(&mut stream, until)?;
        let request = Head::parse(&head);
        let page = format!("/{}/", self.token);
        let route = request
            .path
            .get(..page.len())
            .filter(|prefix| same(prefix, &page));
        let socket = match route.map(|_| &request.path[page.len()..]) {
            Some("") => None,
            Some("in") => Some(Socket::Input),
            Some("out") => Some(Socket::Output),
            _ => {
                respond(&mut stream, "404 Not Found", "text/plain", "", until)?;
                return Ok(None);
            }
        };
        let Some(socket) = socket else {
            respond(
                &mut stream,
                "200 OK",
                "text/html; charset=utf-8",
                PAGE,
                until,
            )?;
            return Ok(None);
        };
        // A WebSocket handshake (RFC 6455 §4.2), from the page's own origin only.
        let key = request.header("sec-websocket-key");
        let upgrade = request
            .header("upgrade")
            .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
            && request.header("connection").is_some_and(|value| {
                value
                    .split(',')
                    .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
            })
            && request.header("sec-websocket-version") == Some("13");
        let (Some(key), true) = (key, upgrade) else {
            respond(&mut stream, "400 Bad Request", "text/plain", "", until)?;
            return Ok(None);
        };
        if request.header("origin") != Some(self.origin().as_str()) {
            respond(&mut stream, "403 Forbidden", "text/plain", "", until)?;
            return Ok(None);
        }
        let accept = tungstenite::handshake::derive_accept_key(key.as_bytes());
        let reply = format!(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
        );
        write_until(&mut stream, reply.as_bytes(), until)?;
        stream.set_read_timeout(None).map_err(backend)?;
        // A page that stops reading must not hang the encoder thread forever.
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(backend)?;
        let limit = match socket {
            // The page never sends on its input socket.
            Socket::Input => 64 * 1024,
            Socket::Output => MAX_CHUNK_MESSAGE,
        };
        let config = WebSocketConfig::default()
            .max_message_size(Some(limit))
            .max_frame_size(Some(limit));
        Ok(Some((
            socket,
            WebSocket::from_raw_socket(stream, Role::Server, Some(config)),
        )))
    }
}

#[derive(Clone, Copy)]
enum Socket {
    Input,
    Output,
}

/// Constant-time equality, so the token's bytes can't be found one at a time by timing.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |diff, (x, y)| diff | (x ^ y))
            == 0
}

/// A request head: the request line's path and the headers, names lower-cased.
struct Head {
    path: String,
    headers: Vec<(String, String)>,
}

impl Head {
    fn parse(head: &[u8]) -> Self {
        let text = String::from_utf8_lossy(head);
        let mut lines = text.split("\r\n");
        let path = lines
            .next()
            .and_then(|line| line.strip_prefix("GET "))
            .and_then(|rest| rest.split(' ').next())
            .unwrap_or("")
            .to_string();
        let headers = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
            .collect();
        Self { path, headers }
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

/// Reads the request head, at most `MAX_HEAD` bytes, before `until`. Every read is bounded by
/// the time left, so a client that trickles bytes or goes quiet can't hold start-up open. A
/// client says nothing more until it is answered, so bytes past the head are refused.
fn read_head(stream: &mut TcpStream, until: Instant) -> Result<Vec<u8>, CodecError> {
    let mut head = Vec::with_capacity(1024);
    let mut buffer = [0u8; 1024];
    loop {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(CodecError::DeadlineExceeded);
        }
        stream.set_read_timeout(Some(left)).map_err(backend)?;
        let read = match stream.read(&mut buffer) {
            Ok(0) => {
                return Err(CodecError::Backend(
                    "connection closed before its request".into(),
                ));
            }
            Ok(read) => read,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                return Err(CodecError::DeadlineExceeded);
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(backend(error)),
        };
        head.extend_from_slice(&buffer[..read]);
        if let Some(end) = head.windows(4).position(|w| w == b"\r\n\r\n") {
            if end + 4 != head.len() {
                return Err(CodecError::InvalidInput(
                    "data after the request head".into(),
                ));
            }
            return Ok(head);
        }
        if head.len() >= MAX_HEAD {
            return Err(CodecError::InvalidInput("request head too large".into()));
        }
    }
}

fn write_until(stream: &mut TcpStream, bytes: &[u8], until: Instant) -> Result<(), CodecError> {
    let left = until
        .saturating_duration_since(Instant::now())
        .max(Duration::from_millis(1));
    stream.set_write_timeout(Some(left)).map_err(backend)?;
    stream.write_all(bytes).map_err(backend)?;
    stream.flush().map_err(backend)
}

fn respond(
    stream: &mut TcpStream,
    status: &str,
    kind: &str,
    body: &str,
    until: Instant,
) -> Result<(), CodecError> {
    let reply = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    write_until(stream, reply.as_bytes(), until)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(port: u16, path: &str, extra: &str) -> std::io::Result<String> {
        let mut stream = TcpStream::connect(("127.0.0.1", port))?;
        write!(
            stream,
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{extra}\r\n"
        )?;
        let mut reply = String::new();
        stream.read_to_string(&mut reply)?;
        Ok(reply)
    }

    #[test]
    fn serves_the_page_only_under_its_token_and_refuses_other_origins() -> Result<(), CodecError> {
        let listener = Listener::bind()?;
        let port = listener.port;
        let url = listener.url();
        let token = listener.token.clone();
        let client = std::thread::spawn(move || -> std::io::Result<(String, String, String)> {
            let page = get(port, &format!("/{token}/"), "")?;
            let wrong = get(port, "/not-the-token/", "")?;
            // Same length as the token, one character off.
            let mut near = token.clone().into_bytes();
            near[0] = if near[0] == b'0' { b'1' } else { b'0' };
            let near = String::from_utf8(near).unwrap_or_default();
            let near = get(port, &format!("/{near}/"), "")?;
            assert!(near.starts_with("HTTP/1.1 404"), "{near}");
            let upgrade = "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n";
            let foreign = get(
                port,
                &format!("/{token}/in"),
                &format!("{upgrade}Origin: http://evil.example\r\n"),
            )?;
            Ok((page, wrong, foreign))
        });
        let started = Instant::now();
        let result = listener.accept(started + Duration::from_millis(1500), &|| true);
        assert!(matches!(result, Err(CodecError::DeadlineExceeded)));
        let (page, wrong, foreign) = client
            .join()
            .map_err(|_| CodecError::Backend("client panicked".into()))?
            .map_err(backend)?;
        assert!(page.starts_with("HTTP/1.1 200 OK"), "{page}");
        assert!(page.contains("<script>"));
        assert!(wrong.starts_with("HTTP/1.1 404"), "{wrong}");
        assert!(foreign.starts_with("HTTP/1.1 403"), "{foreign}");
        assert!(url.ends_with('/'));
        Ok(())
    }

    #[test]
    fn a_client_that_trickles_its_head_cannot_hold_start_up_past_the_deadline()
    -> Result<(), CodecError> {
        let listener = Listener::bind()?;
        let port = listener.port;
        let client = std::thread::spawn(move || -> std::io::Result<()> {
            let mut stream = TcpStream::connect(("127.0.0.1", port))?;
            for _ in 0..40 {
                if stream.write_all(b"G").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Ok(())
        });
        let started = Instant::now();
        let result = listener.accept(started + Duration::from_millis(400), &|| true);
        assert!(matches!(result, Err(CodecError::DeadlineExceeded)));
        assert!(
            started.elapsed() < Duration::from_millis(900),
            "{:?}",
            started.elapsed()
        );
        let _ = client.join();
        Ok(())
    }

    #[test]
    fn the_page_origin_gets_both_sockets() -> Result<(), CodecError> {
        use tungstenite::client::IntoClientRequest;
        let listener = Listener::bind()?;
        let (url, origin) = (listener.url(), listener.origin());
        let client = std::thread::spawn(move || -> Result<(), String> {
            let mut sockets = Vec::new();
            for path in ["in", "out"] {
                let target = format!("{}{path}", url.replace("http://", "ws://"));
                let mut request = target.into_client_request().map_err(|e| e.to_string())?;
                let value = origin.parse().map_err(|_| "origin".to_string())?;
                request.headers_mut().insert("Origin", value);
                let stream =
                    TcpStream::connect(("127.0.0.1", port_of(&url))).map_err(|e| e.to_string())?;
                let (socket, _) =
                    tungstenite::client::client(request, stream).map_err(|e| e.to_string())?;
                sockets.push(socket);
            }
            std::thread::sleep(Duration::from_millis(200));
            Ok(())
        });
        let sockets = listener.accept(Instant::now() + Duration::from_secs(5), &|| true);
        assert!(sockets.is_ok());
        client
            .join()
            .map_err(|_| CodecError::Backend("client panicked".into()))?
            .map_err(CodecError::Backend)?;
        Ok(())
    }

    fn port_of(url: &str) -> u16 {
        url.rsplit(':')
            .next()
            .and_then(|rest| rest.split('/').next())
            .and_then(|port| port.parse().ok())
            .unwrap_or(0)
    }

    #[test]
    fn token_comparison_needs_every_byte() {
        assert!(same("abcd", "abcd"));
        assert!(!same("abcd", "abce"));
        assert!(!same("abcd", "abc"));
    }
}
