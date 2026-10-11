use ace_screen_helper_windows::{
    codec::{self, Request},
    tree::{self, Query},
};
#[path = "support/dense.rs"]
mod dense;
use dense::Dense;
#[test]
fn dense_tree_and_search_replies_fit_the_daemon_budget_and_remain_successful() {
    for nodes in [128, 512] {
        let request =
            Request::decode(br#"{"version":2,"id":"inspection","op":"ui.tree"}"#).unwrap();
        let tree = tree::walk(&mut Dense, 0, 8, nodes).unwrap();
        assert!(tree.truncated);
        let found = tree::find_from(
            &mut Dense,
            0,
            &Query {
                role: None,
                name: None,
                text: None,
            },
            64,
        )
        .unwrap();
        assert!(found.truncated);
        for data in [
            serde_json::to_value(tree).unwrap(),
            serde_json::to_value(found).unwrap(),
        ] {
            let mut bytes = Vec::new();
            codec::reply(&mut bytes, &request, Ok(data)).unwrap();
            assert!(bytes.len() <= 64 * 1024, "reply is {} bytes", bytes.len());
            let reply: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(reply["ok"], true);
            assert_eq!(reply["data"]["truncated"], true);
        }
    }
}
