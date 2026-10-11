//! Platform-neutral serializer fixture consumed by the daemon interoperability test.
#[path = "../tests/support/dense.rs"]
mod dense;
use ace_screen_helper_windows::{
    codec::{self, Request},
    tree::{self, Query},
};
fn main() {
    let nodes = std::env::args().nth(1).unwrap().parse().unwrap();
    let tree = tree::walk(&mut dense::Dense, 0, 8, nodes).unwrap();
    let found = tree::find_from(
        &mut dense::Dense,
        0,
        &Query {
            role: None,
            name: None,
            text: None,
        },
        64,
    )
    .unwrap();
    let request = Request::decode(br#"{"version":2,"id":"fixture","op":"ui.tree"}"#).unwrap();
    for data in [
        serde_json::to_value(tree).unwrap(),
        serde_json::to_value(found).unwrap(),
    ] {
        codec::reply(&mut std::io::stdout(), &request, Ok(data)).unwrap();
    }
}
