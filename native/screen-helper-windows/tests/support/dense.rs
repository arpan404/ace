use ace_screen_helper_windows::{
    coordinates::Bounds,
    errors::Result,
    tree::{Node, Source},
};
pub struct Dense;
impl Source for Dense {
    type Element = usize;
    fn node(&mut self, e: &usize) -> Result<Node> {
        Ok(Node {
            r#ref: format!("w{e}"),
            role: "button".into(),
            name: "\0é👨‍👩‍👧‍👦".repeat(256),
            value: Some("label".repeat(256)),
            description: Some("\n\"".repeat(256)),
            bounds: Bounds::default(),
            states: vec![],
            actions: vec!["press".into()],
            children: vec![],
        })
    }
    fn first_child(&mut self, e: &usize) -> Result<Option<usize>> {
        Ok((*e == 0).then_some(1))
    }
    fn next_sibling(&mut self, e: &usize) -> Result<Option<usize>> {
        Ok((*e < 511).then_some(e + 1))
    }
}
