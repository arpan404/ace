//! Reading one accessible element. Calls that do not depend on each other go out together.
use crate::computer::bus::{Bus, BusError, BusResult, Obj};
use crate::computer::outline::{Rect, States};
use atspi::{State, StateSet};
use std::collections::HashMap;

pub const COORD_SCREEN: u32 = 0;
pub const COORD_WINDOW: u32 = 1;

#[derive(Clone, Debug, Default)]
pub struct Interfaces {
    pub action: bool,
    pub component: bool,
    pub text: bool,
    pub editable: bool,
    pub value: bool,
}

#[derive(Clone, Debug)]
pub struct Element {
    pub obj: Obj,
    pub role: String,
    pub name: String,
    pub description: String,
    pub states: States,
    pub defunct: bool,
    pub interfaces: Interfaces,
}

pub fn states(set: &StateSet) -> States {
    States {
        focused: set.contains(State::Focused),
        selected: set.contains(State::Selected),
        checked: set.contains(State::Checked),
        pressed: set.contains(State::Pressed),
        indeterminate: set.contains(State::Indeterminate),
        checkable: set.contains(State::Checkable),
        expanded: set.contains(State::Expanded),
        expandable: set.contains(State::Expandable),
        collapsed: set.contains(State::Collapsed),
        sensitive: set.contains(State::Sensitive),
        enabled: set.contains(State::Enabled),
        showing: set.contains(State::Showing),
        editable: set.contains(State::Editable),
        multi_line: set.contains(State::MultiLine),
        iconified: set.contains(State::Iconified),
        active: set.contains(State::Active),
        focusable: set.contains(State::Focusable),
        selectable: set.contains(State::Selectable),
    }
}

/// Role, name, description, states and interfaces in one round of calls.
pub async fn read(bus: &Bus, obj: &Obj) -> BusResult<Element> {
    let (role, name, description, state, interfaces) = tokio::join!(
        bus.atspi::<_, String>(obj, "Accessible", "GetRoleName", &()),
        bus.string_prop(obj, "Accessible", "Name"),
        bus.string_prop(obj, "Accessible", "Description"),
        bus.atspi::<_, StateSet>(obj, "Accessible", "GetState", &()),
        bus.atspi::<_, Vec<String>>(obj, "Accessible", "GetInterfaces", &()),
    );
    if matches!(state, Err(BusError::Timeout)) {
        return Err(BusError::Timeout);
    }
    let role = role?;
    let set = state.unwrap_or_default();
    let interfaces = interfaces.unwrap_or_default();
    let has = |suffix: &str| interfaces.iter().any(|i| i.rsplit('.').next() == Some(suffix));
    Ok(Element {
        obj: obj.clone(),
        role,
        name: name.unwrap_or_default(),
        description: description.unwrap_or_default(),
        defunct: set.contains(State::Defunct),
        states: states(&set),
        interfaces: Interfaces {
            action: has("Action"),
            component: has("Component"),
            text: has("Text"),
            editable: has("EditableText"),
            value: has("Value"),
        },
    })
}

pub async fn action_names(bus: &Bus, obj: &Obj) -> BusResult<Vec<String>> {
    match bus
        .atspi::<_, Vec<(String, String, String)>>(obj, "Action", "GetActions", &())
        .await
    {
        Ok(actions) => Ok(actions.into_iter().map(|(name, _, _)| name).collect()),
        Err(BusError::Timeout) => Err(BusError::Timeout),
        Err(_) => {
            let count = bus.i32_prop(obj, "Action", "NActions").await?;
            let mut names = Vec::new();
            for index in 0..count.clamp(0, 64) {
                names.push(
                    bus.atspi::<_, String>(obj, "Action", "GetName", &(index,))
                        .await
                        .unwrap_or_default(),
                );
            }
            Ok(names)
        }
    }
}

pub async fn do_action(bus: &Bus, obj: &Obj, index: usize) -> BusResult<bool> {
    bus.atspi::<_, bool>(obj, "Action", "DoAction", &(index as i32,)).await
}

pub async fn extents(bus: &Bus, obj: &Obj, coord: u32) -> BusResult<Option<Rect>> {
    let (x, y, w, h) = bus
        .atspi::<_, (i32, i32, i32, i32)>(obj, "Component", "GetExtents", &(coord,))
        .await?;
    // Unrealised widgets (closed menus) report i32::MIN.
    if x <= i32::MIN / 2 || y <= i32::MIN / 2 || w <= 0 || h <= 0 {
        return Ok(None);
    }
    Ok(Some(Rect {
        x: f64::from(x),
        y: f64::from(y),
        w: f64::from(w),
        h: f64::from(h),
    }))
}

pub async fn character_count(bus: &Bus, obj: &Obj) -> BusResult<i32> {
    bus.i32_prop(obj, "Text", "CharacterCount").await
}

pub async fn text(bus: &Bus, obj: &Obj, start: i32, end: i32) -> BusResult<String> {
    bus.atspi::<_, String>(obj, "Text", "GetText", &(start, end)).await
}

/// The text and its full length, at most `limit` characters read.
pub async fn text_head(bus: &Bus, obj: &Obj, limit: i32) -> BusResult<(String, i32)> {
    let count = character_count(bus, obj).await?;
    let text = text(bus, obj, 0, count.clamp(0, limit)).await?;
    Ok((text, count))
}

pub async fn caret(bus: &Bus, obj: &Obj) -> BusResult<i32> {
    bus.i32_prop(obj, "Text", "CaretOffset").await
}

pub async fn selection(bus: &Bus, obj: &Obj) -> Option<(i32, i32)> {
    let count = bus.atspi::<_, i32>(obj, "Text", "GetNSelections", &()).await.ok()?;
    if count < 1 {
        return None;
    }
    let (start, end) = bus
        .atspi::<_, (i32, i32)>(obj, "Text", "GetSelection", &(0i32,))
        .await
        .ok()?;
    (end > start).then_some((start, end))
}

pub async fn current_value(bus: &Bus, obj: &Obj) -> BusResult<f64> {
    bus.f64_prop(obj, "Value", "CurrentValue").await
}

pub async fn attributes(bus: &Bus, obj: &Obj) -> HashMap<String, String> {
    bus.atspi::<_, HashMap<String, String>>(obj, "Accessible", "GetAttributes", &())
        .await
        .unwrap_or_default()
}

pub async fn grab_focus(bus: &Bus, obj: &Obj) -> BusResult<bool> {
    bus.atspi::<_, bool>(obj, "Component", "GrabFocus", &()).await
}

pub async fn parent(bus: &Bus, obj: &Obj) -> Option<Obj> {
    let value = bus.prop(obj, "Accessible", "Parent").await.ok()?;
    let parent: (String, zbus::zvariant::OwnedObjectPath) = value.try_into().ok()?;
    (!crate::computer::bus::is_null(&parent)).then_some(parent)
}
