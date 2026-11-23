// SPDX-License-Identifier: Apache-2.0
//! Pinned TLS remote profile tests using a real `rustls::ServerConnection` over loopback TCP.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

use cli_wire::{
    Clock, ConnectConfig, Connection, DeviceId, DirectRemote, Fingerprint, HostId, HttpMethod,
    RemoteOrigin, TlsPinConfig, Token, WireError, http_request_remote_with_tls,
    parse_leaf_certificate, spki_sha256_fingerprint,
};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::{ServerConfig, ServerConnection, StreamOwned};
use tungstenite::Message;

const DEVICE_TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TICKET_HEX: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
struct FixedClock(u64);

impl Clock for FixedClock {
    fn now_millis(&self) -> u64 {
        self.0
    }
}

struct EphemeralCert {
    dir: PathBuf,
    cert_der: Vec<u8>,
    key_pkcs8_der: Vec<u8>,
}

impl Drop for EphemeralCert {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn run_openssl(args: &[&str]) {
    let out = Command::new("openssl").args(args).output().unwrap();
    assert!(
        out.status.success(),
        "openssl {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
}

fn generate_ephemeral_cert() -> EphemeralCert {
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("cli-wire-tls-{}-{seq}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();

    let cert_pem = dir.join("cert.pem");
    let key_pem = dir.join("key.pem");
    let cert_der = dir.join("cert.der");
    let key_der = dir.join("key.der");

    let (cp, kp, cd, kd) = (
        cert_pem.to_str().unwrap(),
        key_pem.to_str().unwrap(),
        cert_der.to_str().unwrap(),
        key_der.to_str().unwrap(),
    );

    run_openssl(&[
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-days",
        "30",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        kp,
        "-out",
        cp,
    ]);
    run_openssl(&["x509", "-in", cp, "-outform", "DER", "-out", cd]);
    run_openssl(&[
        "pkcs8", "-topk8", "-nocrypt", "-in", kp, "-outform", "DER", "-out", kd,
    ]);

    EphemeralCert {
        dir,
        cert_der: fs::read(&cert_der).unwrap(),
        key_pkcs8_der: fs::read(&key_der).unwrap(),
    }
}

fn server_config(cert: &EphemeralCert) -> Arc<ServerConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let cert_chain = vec![CertificateDer::from(cert.cert_der.clone())];
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(cert.key_pkcs8_der.clone()));
    Arc::new(
        ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(cert_chain, key)
            .unwrap(),
    )
}

#[test]
fn pinned_remote_exchanges_ticket_over_https_and_runs_wss_request() {
    let cert = generate_ephemeral_cert();
    let fp = spki_sha256_fingerprint(&cert.cert_der).unwrap();
    let tls_cfg = server_config(&cert);

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();

    let server = thread::spawn(move || {
        // Connection 1: POST /v1/tickets over TLS
        let (tcp1, _) = listener.accept().unwrap();
        let mut tls1 = StreamOwned::new(ServerConnection::new(Arc::clone(&tls_cfg)).unwrap(), tcp1);
        let mut req_buf = [0_u8; 2048];
        let n = tls1.read(&mut req_buf).unwrap();
        let req_text = std::str::from_utf8(&req_buf[..n]).unwrap();
        assert!(req_text.starts_with("POST /v1/tickets HTTP/1.1\r\n"));
        assert!(
            req_text
                .to_ascii_lowercase()
                .contains(&format!("authorization: bearer {DEVICE_TOKEN}\r\n"))
        );

        let body = format!(r#"{{"ticket":"{TICKET_HEX}","expiresAt":1800000000000}}"#);
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        tls1.write_all(resp.as_bytes()).unwrap();
        tls1.flush().unwrap();
        drop(tls1);

        // Connection 2: WSS with hello{ticket} -> welcome -> request/reply
        let (tcp2, _) = listener.accept().unwrap();
        let tls2 = StreamOwned::new(ServerConnection::new(tls_cfg).unwrap(), tcp2);
        let mut ws = tungstenite::accept(tls2).unwrap();

        let hello_text = match ws.read().unwrap() {
            Message::Text(t) => t.to_string(),
            other => unreachable!("expected hello text frame, got {other:?}"),
        };
        let hello: serde_json::Value = serde_json::from_str(&hello_text).unwrap();
        assert_eq!(hello["type"], "hello");
        assert_eq!(hello["deviceId"], "paired-laptop");
        assert_eq!(hello["ticket"], TICKET_HEX);
        assert!(hello.get("token").is_none());

        ws.send(Message::Text(
            r#"{"type":"welcome","hostId":"remote-host-7","protocolVersion":1,"headSeq":5}"#.into(),
        ))
        .unwrap();

        let req_text = match ws.read().unwrap() {
            Message::Text(t) => t.to_string(),
            other => unreachable!("expected request frame, got {other:?}"),
        };
        let req: serde_json::Value = serde_json::from_str(&req_text).unwrap();
        let id = req["requestId"].as_str().unwrap();
        ws.send(Message::Text(
            format!(r#"{{"type":"cli.result","requestId":"{id}","remote":true,"extra":"kept"}}"#)
                .into(),
        ))
        .unwrap();
    });

    let origin = RemoteOrigin::parse(&format!("https://127.0.0.1:{}/", addr.port())).unwrap();
    let device_id = DeviceId::parse("paired-laptop").unwrap();
    let token = Token::parse(DEVICE_TOKEN).unwrap();
    let host_id = HostId::parse("remote-host-7").unwrap();
    let direct = DirectRemote {
        origin: &origin,
        fingerprint: &fp,
        device_id: &device_id,
        token: &token,
        host_id: Some(&host_id),
    };

    let mut conn = Connection::open_remote(&direct, &ConnectConfig::default()).unwrap();
    assert_eq!(conn.welcome().host_id.as_str(), "remote-host-7");
    let reply = conn
        .request_raw(r#"{"type":"status"}"#, Duration::from_secs(2))
        .unwrap();
    assert!(reply.as_str().contains(r#""remote":true"#));
    assert!(reply.as_str().contains(r#""extra":"kept""#));
    conn.close();
    server.join().unwrap();
}

#[test]
fn mismatched_pin_and_expired_cert_fail_with_auth_before_sending_credentials() {
    let cert = generate_ephemeral_cert();
    let info = parse_leaf_certificate(&cert.cert_der).unwrap();
    let real_fp = spki_sha256_fingerprint(&cert.cert_der).unwrap();
    let wrong_fp =
        Fingerprint::parse("0000000000000000000000000000000000000000000000000000000000000000")
            .unwrap();
    let tls_cfg = server_config(&cert);

    // Spawn a server that accepts 3 TLS connections and records whether ANY application data
    // arrives after the handshake (it must NOT).
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    let received_app_data = Arc::new(AtomicBool::new(false));
    let seen_flag = Arc::clone(&received_app_data);

    let server = thread::spawn(move || {
        for _ in 0..3 {
            let (tcp, _) = listener.accept().unwrap();
            let mut tls =
                StreamOwned::new(ServerConnection::new(Arc::clone(&tls_cfg)).unwrap(), tcp);
            let mut buf = [0_u8; 64];
            if let Ok(n) = tls.read(&mut buf)
                && n > 0
            {
                seen_flag.store(true, Ordering::SeqCst);
            }
        }
    });

    let origin = RemoteOrigin::parse(&format!("https://127.0.0.1:{}/", addr.port())).unwrap();
    let device_id = DeviceId::parse("paired-laptop").unwrap();
    let token = Token::parse(DEVICE_TOKEN).unwrap();

    // 1) Wrong SPKI fingerprint
    let direct_wrong = DirectRemote {
        origin: &origin,
        fingerprint: &wrong_fp,
        device_id: &device_id,
        token: &token,
        host_id: None,
    };
    let err_pin = http_request_remote_with_tls(
        &direct_wrong,
        &TlsPinConfig::new(wrong_fp.clone()),
        HttpMethod::Get,
        "/v1/status",
        None,
        Duration::from_secs(2),
    )
    .unwrap_err();
    assert!(matches!(err_pin, WireError::Auth { revoked: false, .. }));
    assert_eq!(err_pin.exit_code(), 4);

    // 2) Valid pin, but clock is at notAfter (expired)
    let direct_real = DirectRemote {
        origin: &origin,
        fingerprint: &real_fp,
        device_id: &device_id,
        token: &token,
        host_id: None,
    };
    let expired_tls = TlsPinConfig {
        fingerprint: real_fp.clone(),
        clock: Arc::new(FixedClock(info.not_after_ms)),
        tailnet_roots: None,
    };
    let err_exp = http_request_remote_with_tls(
        &direct_real,
        &expired_tls,
        HttpMethod::Get,
        "/v1/status",
        None,
        Duration::from_secs(2),
    )
    .unwrap_err();
    assert!(matches!(err_exp, WireError::Auth { revoked: false, .. }));
    assert_eq!(err_exp.exit_code(), 4);

    // 3) Valid pin, but clock is before notBefore (not yet valid)
    let early_tls = TlsPinConfig {
        fingerprint: real_fp.clone(),
        clock: Arc::new(FixedClock(info.not_before_ms.saturating_sub(1_000))),
        tailnet_roots: None,
    };
    let err_early = http_request_remote_with_tls(
        &direct_real,
        &early_tls,
        HttpMethod::Get,
        "/v1/status",
        None,
        Duration::from_secs(2),
    )
    .unwrap_err();
    assert!(matches!(err_early, WireError::Auth { revoked: false, .. }));
    assert_eq!(err_early.exit_code(), 4);

    server.join().unwrap();
    assert!(
        !received_app_data.load(Ordering::SeqCst),
        "client must never send HTTP headers or credentials when TLS pinning fails"
    );
}
