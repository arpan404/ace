// SPDX-License-Identifier: Apache-2.0
//! Pinned TLS remote profile tests using a real `rustls::ServerConnection` over loopback TCP.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
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
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName};
use rustls::{ClientConnection, RootCertStore, ServerConfig, ServerConnection, StreamOwned};
use tungstenite::Message;
use tungstenite::protocol::CloseFrame;
use tungstenite::protocol::frame::coding::CloseCode;

const DEVICE_TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TICKET_HEX_1: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TICKET_HEX_2: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

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

struct CaSignedLeaf {
    dir: PathBuf,
    ca_der: Vec<u8>,
    leaf_der: Vec<u8>,
    key_pkcs8_der: Vec<u8>,
}

impl Drop for EphemeralCert {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

impl Drop for CaSignedLeaf {
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

fn pem_to_der(pem: &std::path::Path, der: &std::path::Path) -> Vec<u8> {
    let args = [
        "x509",
        "-in",
        pem.to_str().unwrap(),
        "-outform",
        "DER",
        "-out",
        der.to_str().unwrap(),
    ];
    run_openssl(&args);
    fs::read(der).unwrap()
}

fn generate_ca_signed_leaf(dns_name: &str) -> CaSignedLeaf {
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("cli-wire-ca-{}-{seq}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();

    let ca_pem = dir.join("ca.pem");
    let ca_key = dir.join("ca.key");
    let leaf_csr = dir.join("leaf.csr");
    let leaf_key = dir.join("leaf.key");
    let leaf_pem = dir.join("leaf.pem");
    let leaf_key_der = dir.join("leaf.key.der");
    let ext_cfg = dir.join("ext.cnf");

    fs::write(
        &ext_cfg,
        format!(
            "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:{dns_name}\n"
        ),
    )
    .unwrap();

    let ca_args = [
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
        "/CN=Test Tailnet CA",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-addext",
        "keyUsage=critical,keyCertSign,cRLSign",
        "-keyout",
        ca_key.to_str().unwrap(),
        "-out",
        ca_pem.to_str().unwrap(),
    ];
    run_openssl(&ca_args);

    let subj = format!("/CN={dns_name}");
    let csr_args = [
        "req",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-subj",
        &subj,
        "-keyout",
        leaf_key.to_str().unwrap(),
        "-out",
        leaf_csr.to_str().unwrap(),
    ];
    run_openssl(&csr_args);

    let sign_args = [
        "x509",
        "-req",
        "-in",
        leaf_csr.to_str().unwrap(),
        "-CA",
        ca_pem.to_str().unwrap(),
        "-CAkey",
        ca_key.to_str().unwrap(),
        "-CAcreateserial",
        "-days",
        "30",
        "-extfile",
        ext_cfg.to_str().unwrap(),
        "-out",
        leaf_pem.to_str().unwrap(),
    ];
    run_openssl(&sign_args);

    let pkcs8_args = [
        "pkcs8",
        "-topk8",
        "-nocrypt",
        "-in",
        leaf_key.to_str().unwrap(),
        "-outform",
        "DER",
        "-out",
        leaf_key_der.to_str().unwrap(),
    ];
    run_openssl(&pkcs8_args);

    CaSignedLeaf {
        ca_der: pem_to_der(&ca_pem, &dir.join("ca.der")),
        leaf_der: pem_to_der(&leaf_pem, &dir.join("leaf.der")),
        key_pkcs8_der: fs::read(&leaf_key_der).unwrap(),
        dir,
    }
}

fn server_config_from(cert_der: &[u8], key_pkcs8_der: &[u8]) -> Arc<ServerConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let cert_chain = vec![CertificateDer::from(cert_der.to_vec())];
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_pkcs8_der.to_vec()));
    Arc::new(
        ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(cert_chain, key)
            .unwrap(),
    )
}

fn serve_ticket_request(listener: &TcpListener, tls_cfg: &Arc<ServerConfig>, ticket: &str) {
    let (tcp, _) = listener.accept().unwrap();
    let mut tls = StreamOwned::new(ServerConnection::new(Arc::clone(tls_cfg)).unwrap(), tcp);
    let mut req_buf = [0_u8; 2048];
    let n = tls.read(&mut req_buf).unwrap();
    let req_text = std::str::from_utf8(&req_buf[..n]).unwrap();
    assert!(req_text.starts_with("POST /v1/tickets HTTP/1.1\r\n"));
    assert!(
        req_text
            .to_ascii_lowercase()
            .contains(&format!("authorization: bearer {DEVICE_TOKEN}\r\n"))
    );
    let body = format!(r#"{{"ticket":"{ticket}","expiresAt":1800000000000}}"#);
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    tls.write_all(resp.as_bytes()).unwrap();
    tls.flush().unwrap();
}

#[test]
fn pinned_remote_exchanges_ticket_retries_replaced_credential_and_runs_wss_request() {
    let cert = generate_ephemeral_cert();
    let fp = spki_sha256_fingerprint(&cert.cert_der).unwrap();
    let tls_cfg = server_config_from(&cert.cert_der, &cert.key_pkcs8_der);

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();

    let server = thread::spawn(move || {
        // Attempt 1: POST /v1/tickets -> WSS closes with 4001 "Credential replaced"
        serve_ticket_request(&listener, &tls_cfg, TICKET_HEX_1);
        let (tcp1, _) = listener.accept().unwrap();
        let tls1 = StreamOwned::new(ServerConnection::new(Arc::clone(&tls_cfg)).unwrap(), tcp1);
        let mut ws1 = tungstenite::accept(tls1).unwrap();
        let hello1: serde_json::Value = match ws1.read().unwrap() {
            Message::Text(t) => serde_json::from_str(t.as_str()).unwrap(),
            other => unreachable!("expected hello1 frame, got {other:?}"),
        };
        assert_eq!(hello1["ticket"], TICKET_HEX_1);
        ws1.close(Some(CloseFrame {
            code: CloseCode::from(4001),
            reason: "Credential replaced".into(),
        }))
        .unwrap();
        drop(ws1);

        // Attempt 2: client fetches a fresh ticket and succeeds.
        serve_ticket_request(&listener, &tls_cfg, TICKET_HEX_2);
        let (tcp2, _) = listener.accept().unwrap();
        let tls2 = StreamOwned::new(ServerConnection::new(tls_cfg).unwrap(), tcp2);
        let mut ws2 = tungstenite::accept(tls2).unwrap();

        let hello2_text = match ws2.read().unwrap() {
            Message::Text(t) => t.to_string(),
            other => unreachable!("expected hello2 text frame, got {other:?}"),
        };
        let hello2: serde_json::Value = serde_json::from_str(&hello2_text).unwrap();
        assert_eq!(hello2["type"], "hello");
        assert_eq!(hello2["deviceId"], "paired-laptop");
        assert_eq!(hello2["ticket"], TICKET_HEX_2);
        assert!(hello2.get("token").is_none());

        ws2.send(Message::Text(
            r#"{"type":"welcome","hostId":"remote-host-7","protocolVersion":1,"headSeq":5}"#.into(),
        ))
        .unwrap();

        let req_text = match ws2.read().unwrap() {
            Message::Text(t) => t.to_string(),
            other => unreachable!("expected request frame, got {other:?}"),
        };
        let req: serde_json::Value = serde_json::from_str(&req_text).unwrap();
        let id = req["requestId"].as_str().unwrap();
        ws2.send(Message::Text(
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
fn mismatched_pin_expired_cert_and_tailnet_renewal_rules() {
    let cert = generate_ephemeral_cert();
    let info = parse_leaf_certificate(&cert.cert_der).unwrap();
    let real_fp = spki_sha256_fingerprint(&cert.cert_der).unwrap();
    let wrong_fp =
        Fingerprint::parse("0000000000000000000000000000000000000000000000000000000000000000")
            .unwrap();
    let tls_cfg = server_config_from(&cert.cert_der, &cert.key_pkcs8_der);

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

    assert_tailnet_renewal_rules(&wrong_fp);
}

fn assert_tailnet_renewal_rules(wrong_fp: &Fingerprint) {
    let ca_leaf = generate_ca_signed_leaf("mac.tailnet.ts.net");
    let mut roots = RootCertStore::empty();
    roots
        .add(CertificateDer::from(ca_leaf.ca_der.clone()))
        .unwrap();
    let tailnet_server_cfg = server_config_from(&ca_leaf.leaf_der, &ca_leaf.key_pkcs8_der);
    let tn_listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let tn_addr = tn_listener.local_addr().unwrap();
    let tn_server = thread::spawn(move || {
        for _ in 0..3 {
            let (mut tcp, _) = tn_listener.accept().unwrap();
            let mut srv = ServerConnection::new(Arc::clone(&tailnet_server_cfg)).unwrap();
            let _ = srv.complete_io(&mut tcp);
        }
    });

    let handshake_as = |client_cfg: Arc<rustls::ClientConfig>, host: &str| -> Result<(), String> {
        let mut tcp = TcpStream::connect(tn_addr).unwrap();
        tcp.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        tcp.set_write_timeout(Some(Duration::from_secs(2))).unwrap();
        let name = ServerName::try_from(host.to_owned()).unwrap();
        let mut cli = ClientConnection::new(client_cfg, name).unwrap();
        while cli.is_handshaking() {
            cli.complete_io(&mut tcp).map_err(|e| e.to_string())?;
        }
        Ok(())
    };

    let renewal_cfg = TlsPinConfig {
        fingerprint: wrong_fp.clone(),
        clock: Arc::new(cli_wire::SystemClock),
        tailnet_roots: Some(Arc::new(roots)),
    }
    .build_client_config()
    .unwrap();
    assert!(handshake_as(Arc::clone(&renewal_cfg), "mac.tailnet.ts.net").is_ok());
    assert!(handshake_as(renewal_cfg, "wrong.tailnet.ts.net").is_err());

    // Without custom test roots, system roots reject the untrusted CA for mac.tailnet.ts.net.
    let default_roots_cfg = TlsPinConfig::new(wrong_fp.clone())
        .build_client_config()
        .unwrap();
    assert!(handshake_as(default_roots_cfg, "mac.tailnet.ts.net").is_err());

    tn_server.join().unwrap();
}
