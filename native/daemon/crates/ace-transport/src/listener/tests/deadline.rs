// SPDX-License-Identifier: Apache-2.0
//! The close deadline's rule: a connection is cancelled at the deadline unless
//! its upgrade has begun writing its `101`, which the deadline waits for.

use Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

use super::super::LoopbackListener;
use super::{answer, client, internal_server};
use crate::driver::{Grace, UpgradeHandler, UpgradeIo, UpgradeReply};
use crate::hop::HopSecret;
use crate::proxy::ProxyTarget;

/// An upgrade handler that arms its grace and then holds for `hold` before it
/// writes: the connection a close deadline must not cancel once writing.
struct WritingUpgrades {
    hold: Duration,
    /// Signals the test once the grace is armed, so the deadline is called on a
    /// connection that is provably writing.
    armed: Arc<tokio::sync::Notify>,
}

impl UpgradeHandler for WritingUpgrades {
    fn upgrade_raw(
        &self,
        _head: crate::head::RequestHead,
        mut stream: crate::prefixed::Prefixed<TcpStream>,
        _peer: crate::peer::Peer,
        _shutdown: CancellationToken,
        grace: Grace,
    ) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        let hold = self.hold;
        let armed = Arc::clone(&self.armed);
        Box::pin(async move {
            if !grace.arm() {
                return;
            }
            armed.notify_one();
            tokio::time::sleep(hold).await;
            let _ = stream.write_all(b"one hundred and one").await;
            let _ = stream.flush().await;
        })
    }

    fn upgrade_hyper(
        &self,
        _head: crate::head::RequestHead,
        _peer: crate::peer::Peer,
        _shutdown: CancellationToken,
        _grace: Grace,
    ) -> Pin<Box<dyn Future<Output = UpgradeReply> + Send>> {
        Box::pin(async { UpgradeReply::Drop })
    }

    fn switched(&self, _reservation: u64, stream: Option<Box<dyn UpgradeIo>>) {
        drop(stream);
    }
}

/// An upgrade handler that never arms: the connection the deadline cancels.
struct WaitingUpgrades {
    hold: Duration,
}

impl UpgradeHandler for WaitingUpgrades {
    fn upgrade_raw(
        &self,
        _head: crate::head::RequestHead,
        _stream: crate::prefixed::Prefixed<TcpStream>,
        _peer: crate::peer::Peer,
        _shutdown: CancellationToken,
        _grace: Grace,
    ) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        let hold = self.hold;
        Box::pin(async move {
            tokio::time::sleep(hold).await;
        })
    }

    fn upgrade_hyper(
        &self,
        _head: crate::head::RequestHead,
        _peer: crate::peer::Peer,
        _shutdown: CancellationToken,
        _grace: Grace,
    ) -> Pin<Box<dyn Future<Output = UpgradeReply> + Send>> {
        Box::pin(async { UpgradeReply::Drop })
    }

    fn switched(&self, _reservation: u64, stream: Option<Box<dyn UpgradeIo>>) {
        drop(stream);
    }
}

const CANDIDATE: &[u8] =
    b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n";

async fn listener_with_handler(
    upstream: SocketAddr,
    upgrades: Arc<dyn UpgradeHandler>,
) -> LoopbackListener {
    let secret = Arc::new(HopSecret::from_hex(&"ab".repeat(32)).expect("a test secret"));
    let target = ProxyTarget::new(upstream, secret).expect("a loopback target");
    let addr: SocketAddr = "127.0.0.1:0".parse().expect("a test address");
    LoopbackListener::bind_with(addr, target, upgrades, 64)
        .await
        .expect("the listener binds")
}

#[tokio::test]
async fn a_close_deadline_does_not_cancel_a_connection_writing_its_101() {
    let (upstream, _) = internal_server().await;
    let armed = Arc::new(tokio::sync::Notify::new());
    let bound = listener_with_handler(
        upstream,
        Arc::new(WritingUpgrades {
            hold: Duration::from_millis(300),
            armed: Arc::clone(&armed),
        }),
    )
    .await;
    let mut client = client(bound.local_addr()).await;
    client
        .write_all(CANDIDATE)
        .await
        .expect("the upgrade is written");
    // Close only once the connection is provably writing its 101.
    tokio::time::timeout(Duration::from_secs(2), armed.notified())
        .await
        .expect("the upgrade reaches its 101");

    let started = std::time::Instant::now();
    bound.close(Duration::from_millis(50)).await;
    assert!(
        started.elapsed() >= Duration::from_millis(200),
        "the deadline waited for the writing connection"
    );
    let answer = tokio::time::timeout(Duration::from_secs(2), answer(&mut client))
        .await
        .expect("the writing connection's answer arrives");
    assert_eq!(
        answer, b"one hundred and one",
        "a connection past its 101 is never cut off by the deadline"
    );
}

#[tokio::test]
async fn a_close_deadline_cancels_a_connection_that_is_not_writing() {
    let (upstream, _) = internal_server().await;
    let bound = listener_with_handler(
        upstream,
        Arc::new(WaitingUpgrades {
            hold: Duration::from_secs(30),
        }),
    )
    .await;
    let mut client = client(bound.local_addr()).await;
    client
        .write_all(CANDIDATE)
        .await
        .expect("the upgrade is written");
    tokio::time::sleep(Duration::from_millis(50)).await;

    bound.close(Duration::from_millis(50)).await;
    let answer = tokio::time::timeout(Duration::from_secs(2), answer(&mut client))
        .await
        .expect("a connection that is not writing is dropped at the deadline");
    assert!(answer.is_empty(), "the cancelled connection writes nothing");
}
