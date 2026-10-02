use super::roles::role;
use super::{
    input::{inject, Action},
    target::Target,
};
use crate::{
    coordinates::Bounds,
    errors::{Code, Error, Result},
    references::References,
    tree::{self, Node, Query, Source},
};
use serde_json::Value;
use windows::{
    core::BSTR,
    Win32::{
        System::{Com::*, Ole::*},
        UI::Accessibility::*,
    },
};
pub struct Automation {
    api: IUIAutomation,
    cache: IUIAutomationCacheRequest,
    walker: IUIAutomationTreeWalker,
    refs: References<IUIAutomationElement>,
    origin: Bounds,
    scale: f64,
}
impl Automation {
    pub fn new() -> Result<Self> {
        unsafe {
            let api: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
            let cache = api.CreateCacheRequest()?;
            cache.SetTreeScope(TreeScope_Element)?;
            for property in [
                UIA_ControlTypePropertyId,
                UIA_NamePropertyId,
                UIA_HelpTextPropertyId,
                UIA_BoundingRectanglePropertyId,
                UIA_HasKeyboardFocusPropertyId,
                UIA_IsEnabledPropertyId,
                UIA_IsOffscreenPropertyId,
                UIA_IsPasswordPropertyId,
                UIA_IsKeyboardFocusablePropertyId,
                UIA_ValueValuePropertyId,
                UIA_SelectionItemIsSelectedPropertyId,
                UIA_ExpandCollapseExpandCollapseStatePropertyId,
                UIA_ToggleToggleStatePropertyId,
            ] {
                cache.AddProperty(property)?;
            }
            for pattern in [
                UIA_InvokePatternId,
                UIA_ValuePatternId,
                UIA_ScrollPatternId,
                UIA_ExpandCollapsePatternId,
                UIA_SelectionItemPatternId,
                UIA_TogglePatternId,
            ] {
                cache.AddPattern(pattern)?;
            }
            let walker = api.ControlViewWalker()?;
            Ok(Self {
                api,
                cache,
                walker,
                refs: References::new(4096),
                origin: Bounds::default(),
                scale: 1.0,
            })
        }
    }
    pub fn clear(&mut self) {
        self.refs.clear();
    }
    fn root(&mut self, target: &Target) -> Result<IUIAutomationElement> {
        let map = target.mapping()?;
        self.origin = map.target;
        self.scale = map.dpi as f64 / 96.0;
        unsafe {
            Ok(self
                .api
                .ElementFromHandleBuildCache(target.window()?, &self.cache)?)
        }
    }
    pub fn tree(&mut self, target: &Target, depth: usize, nodes: usize) -> Result<tree::Tree> {
        let root = self.root(target)?;
        tree::walk(self, root, depth, nodes)
    }
    pub fn find(&mut self, target: &Target, query: &Query, limit: usize) -> Result<Value> {
        let root = self.root(target)?;
        serde_json::to_value(tree::find_from(self, root, query, limit)?)
            .map_err(|e| Error::new(Code::Internal, e.to_string()))
    }
    pub fn act(
        &mut self,
        target: &Target,
        reference: &str,
        action: &str,
        value: Option<&Value>,
    ) -> Result<Value> {
        let element = self
            .refs
            .get(reference)
            .ok_or_else(|| Error::new(Code::TargetGone, "Expired UI reference"))?;
        self.verify_target(target, &element)?;
        let semantic: Result<()> = unsafe {
            match action {
                "focus" => element.SetFocus().map_err(Into::into),
                "press" => element
                    .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                    .and_then(|pattern| pattern.Invoke())
                    .map_err(Into::into),
                "setValue" => {
                    let text = value
                        .and_then(Value::as_str)
                        .filter(|s| s.len() <= 16384)
                        .ok_or_else(|| {
                            Error::new(Code::Bounds, "setValue requires bounded text")
                        })?;
                    if element.CurrentIsPassword()?.as_bool() {
                        return Err(Error::new(
                            Code::PermissionDenied,
                            "Password values are not exposed",
                        ));
                    }
                    element
                        .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                        .and_then(|pattern| pattern.SetValue(&BSTR::from(text)))
                        .map_err(Into::into)
                }
                "scroll" => {
                    let dx = value
                        .and_then(|v| v.get("dx"))
                        .and_then(Value::as_i64)
                        .unwrap_or(0);
                    let dy = value
                        .and_then(|v| v.get("dy"))
                        .and_then(Value::as_i64)
                        .unwrap_or(0);
                    if dx.unsigned_abs() > 1000 || dy.unsigned_abs() > 1000 {
                        return Err(Error::new(Code::Bounds, "Scroll limit"));
                    }
                    element
                        .GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)
                        .and_then(|pattern| pattern.Scroll(amount(dx), amount(dy)))
                        .map_err(Into::into)
                }
                "expand" => element
                    .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(
                        UIA_ExpandCollapsePatternId,
                    )
                    .and_then(|pattern| {
                        if value == Some(&Value::Bool(false)) {
                            pattern.Collapse()
                        } else {
                            pattern.Expand()
                        }
                    })
                    .map_err(Into::into),
                "select" => element
                    .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                        UIA_SelectionItemPatternId,
                    )
                    .and_then(|pattern| pattern.Select())
                    .map_err(Into::into),
                _ => {
                    return Err(Error::new(
                        Code::NotSupported,
                        "Unsupported semantic action",
                    ))
                }
            }
        };
        let outcome = crate::semantic::complete(semantic, || {
            let rect = unsafe { element.CurrentBoundingRectangle()? };
            let mapping = target.mapping()?;
            let scale = mapping.dpi as f64 / 96.0;
            let x = ((rect.left as f64 + rect.right as f64) / 2.0 - mapping.target.x) / scale;
            let y = ((rect.top as f64 + rect.bottom as f64) / 2.0 - mapping.target.y) / scale;
            // Only perform a meaningful fallback. Value insertion first focuses the element by click.
            match action {
                "press" | "select" | "expand" | "focus" => inject(target, &Action::click(x, y))?,
                "setValue" => {
                    inject(target, &Action::click(x, y))?;
                    let mut type_action = Action::click(x, y);
                    type_action.kind = "text.type".into();
                    type_action.text = value.and_then(Value::as_str).map(str::to_owned);
                    // Select existing text before replacing it.
                    let mut select = Action::click(x, y);
                    select.kind = "key.press".into();
                    select.key = Some("A".into());
                    select.modifiers = vec!["control".into()];
                    inject(target, &select)?;
                    inject(target, &type_action)?;
                }
                "scroll" => {
                    let mut scroll = Action::click(x, y);
                    scroll.kind = "scroll".into();
                    scroll.dx = value
                        .and_then(|v| v.get("dx"))
                        .and_then(Value::as_i64)
                        .map(|v| v as i32);
                    scroll.dy = value
                        .and_then(|v| v.get("dy"))
                        .and_then(Value::as_i64)
                        .map(|v| v as i32);
                    inject(target, &scroll)?;
                }
                _ => {
                    return Err(Error::new(
                        Code::NotSupported,
                        "Unsupported semantic action",
                    ))
                }
            }
            Ok(Bounds {
                x,
                y,
                w: 0.0,
                h: 0.0,
            })
        })?;
        serde_json::to_value(outcome).map_err(|e| Error::new(Code::Internal, e.to_string()))
    }
    fn verify_target(&self, target: &Target, element: &IUIAutomationElement) -> Result<()> {
        unsafe {
            let root = self.api.ElementFromHandle(target.window()?)?;
            let mut current = element.clone();
            for _ in 0..64 {
                if self.api.CompareElements(&root, &current)?.as_bool() {
                    return Ok(());
                }
                current = self
                    .walker
                    .GetParentElement(&current)
                    .map_err(|_| Error::new(Code::TargetGone, "Element left target"))?;
            }
        }
        Err(Error::new(
            Code::TargetGone,
            "Element is outside captured window",
        ))
    }
}
fn amount(delta: i64) -> ScrollAmount {
    if delta > 0 {
        ScrollAmount_SmallIncrement
    } else if delta < 0 {
        ScrollAmount_SmallDecrement
    } else {
        ScrollAmount_NoAmount
    }
}
impl Source for Automation {
    type Element = IUIAutomationElement;
    fn node(&mut self, element: &Self::Element) -> Result<Node> {
        unsafe {
            let identity = runtime_id(element)?;
            let reference = self.refs.retain(identity, element.clone());
            let rect = element.CachedBoundingRectangle()?;
            let mut states = vec![];
            let mut actions = vec![];
            if element.CachedHasKeyboardFocus()?.as_bool() {
                states.push("focused".into());
            }
            if !element.CachedIsEnabled()?.as_bool() {
                states.push("disabled".into());
            }
            if element.CachedIsOffscreen()?.as_bool() {
                states.push("offscreen".into());
            }
            if element.CachedIsKeyboardFocusable()?.as_bool() {
                actions.push("focus".into());
            }
            if element
                .GetCachedPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                .is_ok()
            {
                actions.push("press".into());
            }
            let password = element.CachedIsPassword()?.as_bool();
            let value = if let Ok(pattern) =
                element.GetCachedPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            {
                if !password && !pattern.CachedIsReadOnly()?.as_bool() {
                    actions.push("setValue".into());
                }
                if password {
                    None
                } else {
                    Some(pattern.CachedValue()?.to_string())
                }
            } else {
                None
            };
            if element
                .GetCachedPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)
                .is_ok()
            {
                actions.push("scroll".into());
            }
            if let Ok(pattern) = element.GetCachedPatternAs::<IUIAutomationExpandCollapsePattern>(
                UIA_ExpandCollapsePatternId,
            ) {
                actions.push("expand".into());
                if pattern.CachedExpandCollapseState()? == ExpandCollapseState_Expanded {
                    states.push("expanded".into());
                }
            }
            if let Ok(pattern) = element
                .GetCachedPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
            {
                actions.push("select".into());
                if pattern.CachedIsSelected()?.as_bool() {
                    states.push("selected".into());
                }
            }
            if let Ok(pattern) =
                element.GetCachedPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
            {
                if pattern.CachedToggleState()? == ToggleState_On {
                    states.push("checked".into());
                }
            }
            Ok(Node {
                r#ref: reference,
                role: role(element.CachedControlType()?).into(),
                name: element.CachedName()?.to_string(),
                value,
                description: Some(element.CachedHelpText()?.to_string()),
                bounds: Bounds {
                    x: (rect.left as f64 - self.origin.x) / self.scale,
                    y: (rect.top as f64 - self.origin.y) / self.scale,
                    w: (rect.right - rect.left).max(0) as f64 / self.scale,
                    h: (rect.bottom - rect.top).max(0) as f64 / self.scale,
                },
                states,
                actions,
                children: vec![],
            })
        }
    }
    fn first_child(&mut self, element: &Self::Element) -> Result<Option<Self::Element>> {
        optional(unsafe {
            self.walker
                .GetFirstChildElementBuildCache(element, &self.cache)
        })
    }
    fn next_sibling(&mut self, element: &Self::Element) -> Result<Option<Self::Element>> {
        optional(unsafe {
            self.walker
                .GetNextSiblingElementBuildCache(element, &self.cache)
        })
    }
}
fn optional(
    value: windows::core::Result<IUIAutomationElement>,
) -> Result<Option<IUIAutomationElement>> {
    match value {
        Ok(element) => Ok(Some(element)),
        Err(e) if e.code().0 as u32 == 0x80004003 => Ok(None),
        Err(e) => Err(e.into()),
    }
}
fn runtime_id(element: &IUIAutomationElement) -> Result<String> {
    unsafe {
        let array = element.GetRuntimeId()?;
        if array.is_null() {
            return Err(Error::new(Code::TargetGone, "Element has no runtime id"));
        }
        let result = (|| {
            if SafeArrayGetDim(array) != 1 || SafeArrayGetElemsize(array) != 4 {
                return Err(Error::new(Code::Internal, "Invalid runtime id"));
            }
            let low = SafeArrayGetLBound(array, 1)?;
            let high = SafeArrayGetUBound(array, 1)?;
            if high < low || high as i64 - low as i64 > 64 {
                return Err(Error::new(Code::Bounds, "Runtime id too large"));
            }
            let mut id = String::new();
            for index in low..=high {
                let mut value = 0i32;
                SafeArrayGetElement(array, &index, (&mut value as *mut i32).cast())?;
                id.push_str(&format!("{value}:"));
            }
            Ok(id)
        })();
        let _ = SafeArrayDestroy(array);
        result
    }
}
