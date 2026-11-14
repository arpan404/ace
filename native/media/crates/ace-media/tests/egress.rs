// SPDX-License-Identifier: Apache-2.0
//! The egress lane on the real binary: open for the process's lifetime, idle while no source
//! needs it, and carrying each source's units under that source's handle once turned on.
#![cfg(unix)]
mod support;

use media_wire::control::Status;
use media_wire::frame::Egress;
use serde_json::json;
use std::io::{ErrorKind, Read, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;
use support::*;

/// One whole egress frame, or None when nothing came within the socket's read timeout.
fn read_egress(lane: &mut UnixStream) -> Option<Egress> {
    let mut head = [0u8; 24];
    match lane.read_exact(&mut head) {
        Ok(()) => {}
        Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => return None,
        Err(e) => panic!("egress lane: {e}"),
    }
    let header = u16::from_be_bytes([head[18], head[19]]) as usize;
    let payload = u32::from_be_bytes([head[20], head[21], head[22], head[23]]) as usize;
    let mut bytes = head.to_vec();
    bytes.resize(12 + header + payload, 0);
    if let Err(e) = lane.read_exact(&mut bytes[24..]) {
        panic!("egress lane: {e}");
    }
    match Egress::decode(&bytes) {
        Ok(egress) => Some(egress),
        Err(_) => panic!("invalid egress frame"),
    }
}

/// Waits until ace-media has taken every earlier normal-lane message: the lane is one FIFO, so
/// its pong comes after them. Ingest frames sent after this see their effect.
fn settle(media: &mut Media, id: &str) {
    media.send(json!({ "type": "ping", "id": id }), &[]);
    loop {
        if let media_wire::control::FromMedia::Pong { id: got, .. } = media.read()
            && got.get() == id
        {
            return;
        }
    }
}

fn producer(ingest: &str, token: u8) -> UnixStream {
    let Ok(mut producer) = UnixStream::connect(ingest) else {
        panic!("ingest socket refused the connection");
    };
    let _ = producer.write_all(&media_frame(5, 0, vec![token; 32]));
    producer
}

#[test]
fn the_egress_lane_idles_until_a_source_needs_it_then_carries_its_units_under_its_handle() {
    let mut media = Media::spawn("egress");
    let (control, ingest, _) = media.start();
    let Some(_priority) = lane(&control, 1, SECRET) else {
        panic!("priority lane refused");
    };
    let Some(mut egress) = lane(&control, 2, SECRET) else {
        panic!("egress lane refused");
    };
    let _ = egress.set_read_timeout(Some(Duration::from_millis(300)));

    open_source(&mut media, "a", 11, 1);
    open_source(&mut media, "b", 22, 2);
    let mut a = producer(&ingest, 1);
    let mut b = producer(&ingest, 2);
    let _ = a.write_all(&media_frame(1, 1, vec![1; 64]));
    assert_eq!(status_of(media.read()), ("a".into(), Status::Playing));
    assert!(read_egress(&mut egress).is_none(), "idle while off");

    // Turned on for both, on the same connection: both producers use encode id 0.
    media.send(
        json!({ "type": "source.egress", "source": "a", "on": true }),
        &[],
    );
    media.send(
        json!({ "type": "source.egress", "source": "b", "on": true }),
        &[],
    );
    settle(&mut media, "p0");
    let _ = b.write_all(&media_frame(1, 1, vec![2; 64]));
    assert_eq!(status_of(media.read()), ("b".into(), Status::Playing));
    let _ = a.write_all(&media_frame(1, 1, vec![3; 64]));
    let _ = b.write_all(&media_frame(1, 0, vec![4; 64]));
    let _ = egress.set_read_timeout(Some(Duration::from_secs(5)));
    let mut got = Vec::new();
    for _ in 0..3 {
        let Some(unit) = read_egress(&mut egress) else {
            panic!("egress carried nothing");
        };
        got.push((unit.handle, unit.sequence, unit.frame.payload[0]));
    }
    got.sort();
    assert_eq!(got, [(11, 0, 3), (22, 0, 2), (22, 1, 4)]);

    // A closed source goes quiet; the lane stays up and idle.
    media.send(json!({ "type": "source.close", "source": "a" }), &[]);
    media.send(
        json!({ "type": "source.egress", "source": "b", "on": false }),
        &[],
    );
    settle(&mut media, "p1");
    let _ = a.write_all(&media_frame(1, 1, vec![5; 64]));
    let _ = b.write_all(&media_frame(1, 1, vec![6; 64]));
    let _ = egress.set_read_timeout(Some(Duration::from_millis(300)));
    assert!(read_egress(&mut egress).is_none(), "idle again");

    // And it carries again without being reopened.
    media.send(
        json!({ "type": "source.egress", "source": "b", "on": true }),
        &[],
    );
    settle(&mut media, "p2");
    let _ = b.write_all(&media_frame(1, 1, vec![7; 64]));
    let _ = egress.set_read_timeout(Some(Duration::from_secs(5)));
    let again = read_egress(&mut egress).map(|u| (u.handle, u.frame.payload[0]));
    assert_eq!(again, Some((22, 7)));
}
