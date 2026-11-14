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
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::protocol::WebSocketConfig;

const PAGE: &str = include_str!("../assets/encoder.html");
/// A request head larger than this is refused.
const MAX_HEAD: usize = 8 * 1024;

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
        stream: TcpStream,
        deadline: Instant,
    ) -> Result<Option<(Socket, WebSocket<TcpStream>)>, CodecError> {
        stream.set_nonblocking(false).map_err(backend)?;
        let left = deadline
            .saturating_duration_since(Instant::now())
            .max(Duration::from_millis(1));
        stream.set_read_timeout(Some(left)).map_err(backend)?;
        stream.set_write_timeout(Some(left)).map_err(backend)?;
        stream.set_nodelay(true).map_err(backend)?;
        let head = peek_head(&stream)?;
        let text = String::from_utf8_lossy(&head);
        let path = text
            .lines()
            .next()
            .and_then(|line| line.strip_prefix("GET "))
            .and_then(|rest| rest.split(' ').next())
            .unwrap_or("");
        let page = format!("/{}/", self.token);
        let socket = match path.strip_prefix(page.as_str()) {
            Some("") => None,
            Some("in") => Some(Socket::Input),
            Some("out") => Some(Socket::Output),
            _ => {
                respond(stream, head.len(), "404 Not Found", "text/plain", "")?;
                return Ok(None);
            }
        };
        let Some(socket) = socket else {
            respond(
                stream,
                head.len(),
                "200 OK",
                "text/html; charset=utf-8",
                PAGE,
            )?;
            return Ok(None);
        };
        let origin = self.origin();
        // The callback's error type is tungstenite's own HTTP response.
        #[allow(clippy::result_large_err)]
        let check = |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
            let from = request
                .headers()
                .get("origin")
                .and_then(|value| value.to_str().ok());
            if from == Some(origin.as_str()) {
                Ok(response)
            } else {
                let mut refused = ErrorResponse::new(None);
                *refused.status_mut() = tungstenite::http::StatusCode::FORBIDDEN;
                Err(refused)
            }
        };
        let config = WebSocketConfig::default()
            .max_message_size(Some(64 << 20))
            .max_frame_size(Some(64 << 20));
        let socket_stream = tungstenite::accept_hdr_with_config(stream, check, Some(config))
            .map_err(|error| CodecError::Backend(format!("encoder socket refused: {error}")))?;
        let tcp = socket_stream.get_ref();
        tcp.set_read_timeout(None).map_err(backend)?;
        // A page that stops reading must not hang the encoder thread forever.
        tcp.set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(backend)?;
        Ok(Some((socket, socket_stream)))
    }
}

#[derive(Clone, Copy)]
enum Socket {
    Input,
    Output,
}

/// The request head, left unread in the socket (a WebSocket handshake reads it again).
fn peek_head(stream: &TcpStream) -> Result<Vec<u8>, CodecError> {
    let mut buffer = vec![0u8; MAX_HEAD];
    loop {
        let read = stream.peek(&mut buffer).map_err(backend)?;
        if read == 0 {
            return Err(CodecError::Backend(
                "connection closed before its request".into(),
            ));
        }
        if let Some(end) = buffer[..read].windows(4).position(|w| w == b"\r\n\r\n") {
            buffer.truncate(end + 4);
            return Ok(buffer);
        }
        if read == MAX_HEAD {
            return Err(CodecError::InvalidInput("request head too large".into()));
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn respond(
    mut stream: TcpStream,
    head: usize,
    status: &str,
    kind: &str,
    body: &str,
) -> Result<(), CodecError> {
    let mut consumed = vec![0u8; head];
    stream.read_exact(&mut consumed).map_err(backend)?;
    let reply = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(reply.as_bytes()).map_err(backend)?;
    stream.flush().map_err(backend)
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
}
