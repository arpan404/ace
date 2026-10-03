use crate::{
    accessibility::{Accessibility, Bounds, semantic},
    protocol::{Fault, Result, internal},
};
impl Accessibility {
    pub async fn act(
        &mut self,
        reference: &str,
        action: &str,
        value: Option<&str>,
    ) -> Result<Option<Bounds>> {
        let object = self
            .refs
            .get(reference)
            .cloned()
            .ok_or_else(|| Fault::new("target_gone", "Unknown or evicted accessibility ref"))?;
        let (node, _) = self.node(&object).await?;
        if node
            .states
            .iter()
            .any(|s| s == "disabled" || s == "offscreen")
        {
            return Err(Fault::new("bounds", "Element is disabled or offscreen"));
        }
        let result: bool = match action {
            "focus" if node.actions.iter().any(|a| a == action) => self
                .proxy(&object, "Component")
                .await?
                .call("GrabFocus", &())
                .await
                .map_err(internal)?,
            "scroll" if node.actions.iter().any(|a| a == action) => self
                .proxy(&object, "Component")
                .await?
                .call("ScrollTo", &(0u32,))
                .await
                .map_err(internal)?,
            "setValue" if node.actions.iter().any(|a| a == action) => {
                let text = value.ok_or_else(|| Fault::new("bounds", "setValue requires value"))?;
                if text.len() > 4096 {
                    return Err(Fault::new("bounds", "Value exceeds limit"));
                }
                self.proxy(&object, "EditableText")
                    .await?
                    .call("SetTextContents", &(text,))
                    .await
                    .map_err(internal)?
            }
            "press" | "expand" | "select" if node.actions.iter().any(|a| a == action) => {
                let p = self.proxy(&object, "Action").await?;
                let n: i32 = p.get_property("NActions").await.map_err(internal)?;
                let mut index = None;
                for i in 0..n.clamp(0, 32) {
                    let name: String = p.call("GetName", &(i,)).await.map_err(internal)?;
                    if semantic(&name) == Some(action) {
                        index = Some(i);
                        break;
                    }
                }
                p.call(
                    "DoAction",
                    &(index.ok_or_else(|| Fault::new("target_gone", "Action changed"))?,),
                )
                .await
                .map_err(internal)?
            }
            "press" | "focus" => return Ok(Some(node.bounds)),
            _ => {
                return Err(Fault::new(
                    "not_supported",
                    "Semantic action is unsupported; no safe pointer equivalent",
                ));
            }
        };
        if !result {
            return Err(Fault::new(
                "internal",
                "Application rejected semantic action",
            ));
        }
        Ok(None)
    }
    pub async fn type_text(&mut self, text: &str) -> Result<()> {
        let root = self
            .scope
            .clone()
            .ok_or_else(|| Fault::new("target_gone", "No accessibility target"))?;
        let mut stack = vec![(root, 0usize)];
        let mut seen = std::collections::HashSet::new();
        while let Some((object, depth)) = stack.pop() {
            let key = format!("{}{}", object.0, object.1);
            if !seen.insert(key) {
                continue;
            }
            let (node, count) = self.node(&object).await?;
            if node.states.iter().any(|s| s == "focused")
                && node.actions.iter().any(|s| s == "setValue")
            {
                let p = self.proxy(&object, "Text").await?;
                let offset: i32 = p.get_property("CaretOffset").await.map_err(internal)?;
                let ok: bool = self
                    .proxy(&object, "EditableText")
                    .await?
                    .call("InsertText", &(offset, text, text.chars().count() as i32))
                    .await
                    .map_err(internal)?;
                if ok {
                    return Ok(());
                }
                return Err(Fault::new(
                    "internal",
                    "Application rejected text insertion",
                ));
            }
            if seen.len() >= 512 {
                break;
            }
            if depth >= 32 {
                continue;
            }
            let available = 512usize.saturating_sub(seen.len() + stack.len());
            let a = self.proxy(&object, "Accessible").await?;
            for index in (0..count.min(available as i32)).rev() {
                let child: crate::accessibility::Object = a
                    .call("GetChildAtIndex", &(index,))
                    .await
                    .map_err(internal)?;
                stack.push((child, depth + 1));
            }
        }
        Err(Fault::new(
            "not_supported",
            "Focused element has no direct text insertion interface within traversal caps",
        ))
    }
}
