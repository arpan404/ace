//! UI Automation access: one client per helper, cache requests that fetch everything the
//! outline needs in one round trip, and reading an element's facts from that cache.
use super::error::{CuError, CuResult};
use super::outline::{control, Facts, Rect};
use windows::core::{Interface, BSTR, VARIANT};
use windows::Win32::{
    Foundation::HWND,
    System::{Com::*, Ole::*},
    UI::{Accessibility::*, WindowsAndMessaging::*},
};

pub struct Uia {
    pub api: IUIAutomation,
    /// The element and its whole control-view subtree, for a look.
    pub tree: IUIAutomationCacheRequest,
    /// One element, for walking a large window step by step.
    pub one: IUIAutomationCacheRequest,
    pub walker: IUIAutomationTreeWalker,
}

const PROPERTIES: [UIA_PROPERTY_ID; 28] = [
    UIA_RuntimeIdPropertyId,
    UIA_ControlTypePropertyId,
    UIA_NamePropertyId,
    UIA_HelpTextPropertyId,
    UIA_BoundingRectanglePropertyId,
    UIA_HasKeyboardFocusPropertyId,
    UIA_IsEnabledPropertyId,
    UIA_IsOffscreenPropertyId,
    UIA_IsPasswordPropertyId,
    UIA_IsKeyboardFocusablePropertyId,
    UIA_NativeWindowHandlePropertyId,
    UIA_ClassNamePropertyId,
    UIA_IsInvokePatternAvailablePropertyId,
    UIA_IsValuePatternAvailablePropertyId,
    UIA_IsTogglePatternAvailablePropertyId,
    UIA_IsExpandCollapsePatternAvailablePropertyId,
    UIA_IsSelectionItemPatternAvailablePropertyId,
    UIA_IsScrollPatternAvailablePropertyId,
    UIA_IsScrollItemPatternAvailablePropertyId,
    UIA_IsTextPatternAvailablePropertyId,
    UIA_IsRangeValuePatternAvailablePropertyId,
    UIA_IsLegacyIAccessiblePatternAvailablePropertyId,
    UIA_ValueValuePropertyId,
    UIA_ValueIsReadOnlyPropertyId,
    UIA_ToggleToggleStatePropertyId,
    UIA_ExpandCollapseExpandCollapseStatePropertyId,
    UIA_SelectionItemIsSelectedPropertyId,
    UIA_LegacyIAccessibleDefaultActionPropertyId,
];

fn cache(
    api: &IUIAutomation,
    scope: TreeScope,
) -> windows::core::Result<IUIAutomationCacheRequest> {
    unsafe {
        let request = api.CreateCacheRequest()?;
        request.SetTreeScope(scope)?;
        for property in PROPERTIES {
            request.AddProperty(property)?;
        }
        // Windows 10 1809 and later; older systems simply report no dialogs.
        let _ = request.AddProperty(UIA_IsDialogPropertyId);
        Ok(request)
    }
}

impl Uia {
    pub fn new() -> CuResult<Self> {
        unsafe {
            let api: IUIAutomation = CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
                .or_else(|_| CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER))
                .map_err(|e| {
                    CuError::new(
                        "permission_accessibility",
                        format!("UI Automation is unavailable on this computer ({e})."),
                    )
                })?;
            // A hung app costs at most this long per request instead of stalling the helper.
            if let Ok(api2) = api.cast::<IUIAutomation2>() {
                let _ = api2.SetConnectionTimeout(2_000);
                let _ = api2.SetTransactionTimeout(2_000);
            }
            let tree = cache(&api, TreeScope_Subtree).map_err(internal)?;
            let one = cache(&api, TreeScope_Element).map_err(internal)?;
            let walker = api.ControlViewWalker().map_err(internal)?;
            Ok(Self {
                api,
                tree,
                one,
                walker,
            })
        }
    }

    /// A fresh, cached copy of an element, for reading its current facts.
    pub fn refresh(&self, element: &IUIAutomationElement) -> CuResult<IUIAutomationElement> {
        unsafe { element.BuildUpdatedCache(&self.one) }.map_err(|e| stale_or(e, "read"))
    }

    pub fn parent(&self, element: &IUIAutomationElement) -> Option<IUIAutomationElement> {
        unsafe { self.walker.GetParentElementBuildCache(element, &self.one) }.ok()
    }
}

pub fn internal(error: windows::core::Error) -> CuError {
    CuError::new("internal", format!("UI Automation failed: {error}"))
}

const UIA_E_ELEMENTNOTAVAILABLE: u32 = 0x8004_0201;
const UIA_E_ELEMENTNOTENABLED: u32 = 0x8004_0200;
const UIA_E_NOTSUPPORTED: u32 = 0x8004_0204;
const UIA_E_INVALIDOPERATION: u32 = 0x8013_1509;
const UIA_E_TIMEOUT: u32 = 0x8013_1505;
const E_ACCESSDENIED: u32 = 0x8007_0005;

pub fn is_timeout(error: &windows::core::Error) -> bool {
    error.code().0 as u32 == UIA_E_TIMEOUT
}

/// A failed UI Automation call on an element as the model should hear it.
pub fn stale_or(error: windows::core::Error, what: &str) -> CuError {
    match error.code().0 as u32 {
        UIA_E_ELEMENTNOTAVAILABLE => CuError::new(
            "stale_element",
            "That element is no longer in the window. Look again (screen_state) and use the new ids.",
        ),
        UIA_E_ELEMENTNOTENABLED => CuError::new(
            "action_failed",
            format!("The element is disabled, so the {what} did nothing."),
        ),
        UIA_E_TIMEOUT => CuError::new(
            "app_busy",
            format!("The app did not answer the {what} (it may be busy or showing a modal dialog). It may still have taken effect: observe before retrying."),
        ),
        E_ACCESSDENIED => CuError::new(
            "action_failed",
            format!("Windows refused the {what}: the app may run as administrator, which blocks ace."),
        ),
        UIA_E_NOTSUPPORTED | 0x8000_4001 | 0x8000_4002 => CuError::new(
            "not_supported",
            format!("The element does not support the {what}."),
        ),
        UIA_E_INVALIDOPERATION => CuError::new(
            "action_failed",
            format!("The app refused the {what} in its current state."),
        ),
        _ => CuError::new("action_failed", format!("The {what} failed: {error}")),
    }
}

fn cached(element: &IUIAutomationElement, id: UIA_PROPERTY_ID) -> Option<VARIANT> {
    unsafe { element.GetCachedPropertyValue(id) }.ok()
}

fn flag(element: &IUIAutomationElement, id: UIA_PROPERTY_ID) -> Option<bool> {
    cached(element, id).and_then(|v| bool::try_from(&v).ok())
}

fn number(element: &IUIAutomationElement, id: UIA_PROPERTY_ID) -> Option<i32> {
    cached(element, id).and_then(|v| i32::try_from(&v).ok())
}

fn text(element: &IUIAutomationElement, id: UIA_PROPERTY_ID) -> Option<String> {
    cached(element, id)
        .and_then(|v| BSTR::try_from(&v).ok())
        .map(|b| b.to_string())
        .filter(|s| !s.trim().is_empty())
}

/// The element's native window, when it is a Win32 control.
pub fn native_window(element: &IUIAutomationElement) -> Option<HWND> {
    let handle = unsafe { element.CachedNativeWindowHandle() }.ok()?;
    (!handle.0.is_null()).then_some(handle)
}

pub fn class_name(element: &IUIAutomationElement) -> String {
    text(element, UIA_ClassNamePropertyId).unwrap_or_default()
}

/// Win32 edit controls that take EM_REPLACESEL, EM_SETSEL and the clipboard messages.
pub fn is_edit_class(class: &str) -> bool {
    let class = class.to_ascii_lowercase();
    class == "edit"
        || class.starts_with("richedit")
        || class.starts_with("windowsforms10.edit")
        || class.starts_with("windowsforms10.richedit")
}

/// Everything the outline rules need, from the element's cache.
pub fn facts(element: &IUIAutomationElement) -> Facts {
    let control_type = unsafe { element.CachedControlType() }
        .map(|t| t.0)
        .unwrap_or(control::CUSTOM);
    let password = flag(element, UIA_IsPasswordPropertyId).unwrap_or(false);
    let available = |id| flag(element, id).unwrap_or(false);
    let value_pattern = available(UIA_IsValuePatternAvailablePropertyId);
    let multi_line = control_type == control::EDIT
        && native_window(element)
            .is_some_and(|hwnd| (unsafe { GetWindowLongW(hwnd, GWL_STYLE) } as u32) & 0x0004 != 0);
    Facts {
        control_type,
        name: text(element, UIA_NamePropertyId),
        help: text(element, UIA_HelpTextPropertyId),
        value: if value_pattern && !password {
            text(element, UIA_ValueValuePropertyId)
        } else {
            None
        },
        enabled: flag(element, UIA_IsEnabledPropertyId).unwrap_or(true),
        focused: flag(element, UIA_HasKeyboardFocusPropertyId).unwrap_or(false),
        password,
        focusable: flag(element, UIA_IsKeyboardFocusablePropertyId).unwrap_or(false),
        invoke: available(UIA_IsInvokePatternAvailablePropertyId),
        toggle: available(UIA_IsTogglePatternAvailablePropertyId)
            .then(|| number(element, UIA_ToggleToggleStatePropertyId).unwrap_or(0)),
        expand: available(UIA_IsExpandCollapsePatternAvailablePropertyId)
            .then(|| number(element, UIA_ExpandCollapseExpandCollapseStatePropertyId).unwrap_or(0)),
        selected: available(UIA_IsSelectionItemPatternAvailablePropertyId)
            .then(|| flag(element, UIA_SelectionItemIsSelectedPropertyId).unwrap_or(false)),
        value_writable: value_pattern
            .then(|| !flag(element, UIA_ValueIsReadOnlyPropertyId).unwrap_or(true)),
        range_value: available(UIA_IsRangeValuePatternAvailablePropertyId),
        text: available(UIA_IsTextPatternAvailablePropertyId),
        scroll: available(UIA_IsScrollPatternAvailablePropertyId),
        scroll_item: available(UIA_IsScrollItemPatternAvailablePropertyId),
        default_action: available(UIA_IsLegacyIAccessiblePatternAvailablePropertyId)
            .then(|| text(element, UIA_LegacyIAccessibleDefaultActionPropertyId))
            .flatten(),
        multi_line,
        dialog: flag(element, UIA_IsDialogPropertyId).unwrap_or(false),
        in_menu_bar: false,
    }
}

/// The element's frame in physical screen pixels, when it has a size.
pub fn frame(element: &IUIAutomationElement) -> Option<Rect> {
    let rect = unsafe { element.CachedBoundingRectangle() }.ok()?;
    let (w, h) = (rect.right - rect.left, rect.bottom - rect.top);
    (w > 0 && h > 0).then(|| Rect {
        x: f64::from(rect.left),
        y: f64::from(rect.top),
        w: f64::from(w),
        h: f64::from(h),
    })
}

pub fn offscreen(element: &IUIAutomationElement) -> bool {
    flag(element, UIA_IsOffscreenPropertyId).unwrap_or(false)
}

/// The element's runtime id as a string key; unique while the element exists.
pub fn runtime_id(element: &IUIAutomationElement) -> Option<String> {
    unsafe {
        let array = element.GetRuntimeId().ok()?;
        if array.is_null() {
            return None;
        }
        let read = (|| {
            if SafeArrayGetDim(array) != 1 || SafeArrayGetElemsize(array) != 4 {
                return None;
            }
            let low = SafeArrayGetLBound(array, 1).ok()?;
            let high = SafeArrayGetUBound(array, 1).ok()?;
            if high < low || i64::from(high) - i64::from(low) > 64 {
                return None;
            }
            let mut id = String::new();
            for index in low..=high {
                let mut value = 0i32;
                SafeArrayGetElement(array, &index, (&mut value as *mut i32).cast()).ok()?;
                id.push_str(&format!("{value}."));
            }
            Some(id)
        })();
        let _ = SafeArrayDestroy(array);
        read
    }
}

/// The element's children from a subtree cache.
pub fn cached_children(element: &IUIAutomationElement) -> Vec<IUIAutomationElement> {
    let Ok(array) = (unsafe { element.GetCachedChildren() }) else {
        return Vec::new();
    };
    let length = unsafe { array.Length() }.unwrap_or(0).clamp(0, 4096);
    (0..length)
        .filter_map(|index| unsafe { array.GetElement(index) }.ok())
        .collect()
}

/// The element's children, read one round trip at a time, until the deadline.
pub fn live_children(
    uia: &Uia,
    element: &IUIAutomationElement,
    deadline: std::time::Instant,
) -> Vec<IUIAutomationElement> {
    let mut children = Vec::new();
    let mut next = unsafe { uia.walker.GetFirstChildElementBuildCache(element, &uia.one) }.ok();
    while let Some(child) = next {
        if children.len() >= 4096 || std::time::Instant::now() >= deadline {
            break;
        }
        next = unsafe { uia.walker.GetNextSiblingElementBuildCache(&child, &uia.one) }.ok();
        children.push(child);
    }
    children
}

/// A pattern of the live element, or a model-facing error naming what it cannot do.
pub fn pattern<T: Interface>(
    element: &IUIAutomationElement,
    id: UIA_PATTERN_ID,
    what: &str,
) -> CuResult<T> {
    unsafe { element.GetCurrentPatternAs::<T>(id) }.map_err(|e| stale_or(e, what))
}

/// The name of the list row an element sits in, read from its parents, as the walk records it.
pub fn row_of(uia: &Uia, element: &IUIAutomationElement) -> Option<String> {
    let mut current = uia.parent(element)?;
    for _ in 0..8 {
        let facts = facts(&current);
        if facts.control_type == control::WINDOW {
            return None;
        }
        if super::outline::is_row(facts.control_type) {
            return Some(facts.name.unwrap_or_default());
        }
        current = uia.parent(&current)?;
    }
    None
}
