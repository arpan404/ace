use ace_screen_helper_windows::{
    codec,
    coordinates::Bounds,
    errors::Result,
    mailbox::Mailbox,
    references::References,
    tiles::Tiles,
    tree::{self, Node, Query, Source},
};
use std::{hint::black_box, time::Instant};
fn measure(name: &str, count: u32, mut operation: impl FnMut()) {
    let start = Instant::now();
    for _ in 0..count {
        operation();
    }
    println!(
        "{name}: {:.2} us/op",
        start.elapsed().as_secs_f64() * 1e6 / count as f64
    );
}
struct App;
impl Source for App {
    type Element = usize;
    fn node(&mut self, e: &usize) -> Result<Node> {
        Ok(Node {
            r#ref: format!("r{e}"),
            role: "button".into(),
            name: "Save".into(),
            value: None,
            description: None,
            bounds: Bounds::default(),
            states: vec![],
            actions: vec!["press".into()],
            children: vec![],
        })
    }
    fn first_child(&mut self, e: &usize) -> Result<Option<usize>> {
        Ok((e * 2 + 1 < 2048).then_some(e * 2 + 1))
    }
    fn next_sibling(&mut self, e: &usize) -> Result<Option<usize>> {
        Ok((*e % 2 == 1 && *e + 1 < 2048).then_some(e + 1))
    }
}
fn main() {
    let mut queue = Mailbox::default();
    measure("retire and replace frame mailbox", 100000, || {
        queue.activate(1);
        queue.publish(1, vec![0; 128]);
        black_box(queue.take());
        queue.retire();
    });
    let rgb: Vec<u8> = (0..1280 * 720 * 3)
        .map(|i| ((i / 3 * 17 + i / 3840 * 29) % 256) as u8)
        .collect();
    let mut tiles = Tiles::default();
    measure("tile hash 720p", 100, || {
        black_box(tiles.changed(&rgb, 1280, 720).unwrap());
    });
    measure("JPEG 720p", 20, || {
        black_box(codec::jpeg(&rgb, 1280, 720).unwrap());
    });
    let line = br#"{"version":2,"id":"r","op":"hello"}"#;
    measure("command decode", 100000, || {
        black_box(codec::Request::decode(line).unwrap());
    });
    measure("tree prune 2048 nodes", 100, || {
        black_box(tree::walk(&mut App, 0, 32, 2048).unwrap());
    });
    let query = Query {
        role: Some("button".into()),
        name: None,
        text: None,
    };
    measure("find first 10 controls", 1000, || {
        black_box(tree::find_from(&mut App, 0, &query, 10).unwrap());
    });
    let mut refs = References::new(4096);
    let mut serial = 0u64;
    measure("reference retain/evict", 100000, || {
        serial += 1;
        black_box(refs.retain(serial.to_string(), 1));
    });
    let payload = codec::jpeg(&rgb, 1280, 720).unwrap();
    let header = codec::Header {
        version: 2,
        session_id: "s".into(),
        seq: 0,
        capture_generation: Some(1),
        ts: 1000.0,
        width: 1280,
        height: 720,
        scale: 1.0,
        codec: "jpeg".into(),
        bytes: payload.len(),
        dirty_rects: None,
    };
    measure("frame packet 720p JPEG", 1000, || {
        black_box(codec::packet(&header, &payload).unwrap());
    });
    println!("JPEG bytes: {}", payload.len());
}
