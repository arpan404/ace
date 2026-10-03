use windows::Win32::UI::Accessibility::*;
pub(super) fn role(id: UIA_CONTROLTYPE_ID) -> &'static str {
    const ROLES: &[(UIA_CONTROLTYPE_ID, &str)] = &[
        (UIA_ButtonControlTypeId, "button"),
        (UIA_EditControlTypeId, "textbox"),
        (UIA_CheckBoxControlTypeId, "checkbox"),
        (UIA_RadioButtonControlTypeId, "radio"),
        (UIA_ComboBoxControlTypeId, "combobox"),
        (UIA_ListItemControlTypeId, "listitem"),
        (UIA_ListControlTypeId, "list"),
        (UIA_MenuControlTypeId, "menu"),
        (UIA_MenuItemControlTypeId, "menuitem"),
        (UIA_TextControlTypeId, "text"),
        (UIA_WindowControlTypeId, "window"),
        (UIA_TabControlTypeId, "tablist"),
        (UIA_TabItemControlTypeId, "tab"),
        (UIA_TreeControlTypeId, "tree"),
        (UIA_TreeItemControlTypeId, "treeitem"),
        (UIA_HyperlinkControlTypeId, "link"),
        (UIA_DocumentControlTypeId, "document"),
        (UIA_ScrollBarControlTypeId, "scrollbar"),
        (UIA_SliderControlTypeId, "slider"),
    ];
    ROLES
        .iter()
        .find(|(control, _)| *control == id)
        .map_or("group", |(_, role)| *role)
}
