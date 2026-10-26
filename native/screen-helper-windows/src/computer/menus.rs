//! Win32 menu bars (HMENU). Menu commands are chosen by posting WM_COMMAND with the item's id,
//! exactly what the app receives when the person picks the item, without opening the menu or
//! activating the window. Submenus are told they are about to open (WM_INITMENUPOPUP) first,
//! so apps fill and enable their items as they would on screen.
use super::error::{clip, CuError, CuResult};
use super::keys::{accelerator as parse_accelerator, same_keys, Chord};
use super::text_match::{choose_menu_item, split_menu_label, MenuChoice};
use windows::core::PWSTR;
use windows::Win32::{Foundation::*, UI::WindowsAndMessaging::*};

pub struct Item {
    pub title: String,
    pub raw: String,
    pub accelerator: Option<String>,
    pub id: u32,
    pub submenu: Option<HMENU>,
    pub disabled: bool,
}

pub fn items(menu: HMENU) -> Vec<Item> {
    let count = unsafe { GetMenuItemCount(menu) }.clamp(0, 256);
    let mut items = Vec::new();
    for index in 0..count {
        let mut buffer = [0u16; 512];
        let mut info = MENUITEMINFOW {
            cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
            fMask: MIIM_STRING | MIIM_ID | MIIM_SUBMENU | MIIM_STATE | MIIM_FTYPE,
            dwTypeData: PWSTR(buffer.as_mut_ptr()),
            cch: (buffer.len() - 1) as u32,
            ..Default::default()
        };
        if unsafe { GetMenuItemInfoW(menu, index as u32, true, &mut info) }.is_err() {
            continue;
        }
        if info.fType.0 & MFT_SEPARATOR.0 != 0 {
            continue;
        }
        let length = (info.cch as usize).min(buffer.len());
        let raw = String::from_utf16_lossy(&buffer[..length]);
        let (title, accelerator) = split_menu_label(&raw);
        if title.is_empty() {
            continue;
        }
        items.push(Item {
            title,
            raw,
            accelerator,
            id: info.wID,
            submenu: (!info.hSubMenu.is_invalid()).then_some(info.hSubMenu),
            disabled: info.fState.0 & (MFS_DISABLED.0 | MFS_GRAYED.0) != 0,
        });
    }
    items
}

pub fn bar(hwnd: HWND) -> Option<HMENU> {
    let menu = unsafe { GetMenu(hwnd) };
    (!menu.is_invalid() && unsafe { IsMenu(menu) }.as_bool()).then_some(menu)
}

/// The menu bar's titles, the entry points for `menu` steps.
pub fn bar_titles(hwnd: HWND) -> Vec<String> {
    bar(hwnd)
        .map(|menu| {
            items(menu)
                .into_iter()
                .filter_map(|item| clip(&item.title, 40))
                .collect()
        })
        .unwrap_or_default()
}

fn prepare(hwnd: HWND, submenu: HMENU, index: usize) {
    unsafe {
        SendMessageTimeoutW(
            hwnd,
            WM_INITMENUPOPUP,
            WPARAM(submenu.0 as usize),
            LPARAM(index as isize),
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            500,
            None,
        );
    }
}

/// The command id of the item at `path`, with the titles as the menu shows them.
pub fn choose(hwnd: HWND, path: &[String]) -> CuResult<(u32, Vec<String>)> {
    let mut menu = bar(hwnd).ok_or_else(|| {
        CuError::new(
            "no_menu_bar",
            "This window has no classic menu bar. Its menus are buttons in the window: click the menu button by id, then the item.",
        )
    })?;
    let mut shown = Vec::new();
    for (depth, wanted) in path.iter().enumerate() {
        let list = items(menu);
        let titles: Vec<String> = list.iter().map(|item| item.raw.clone()).collect();
        let index = match choose_menu_item(&titles, wanted) {
            MenuChoice::Found(index) => index,
            MenuChoice::Ambiguous(names) => {
                return Err(CuError::new(
                    "menu_ambiguous",
                    format!(
                        "\"{wanted}\" matches several menu items: {}. Use the full title.",
                        names.join(", ")
                    ),
                ))
            }
            MenuChoice::Missing => {
                let names: Vec<String> = list.iter().map(|item| item.title.clone()).collect();
                return Err(CuError::new(
                    "menu_not_found",
                    format!(
                        "No menu item \"{wanted}\"{}. The items are: {}.",
                        if shown.is_empty() {
                            String::new()
                        } else {
                            format!(" in {}", shown.join(" › "))
                        },
                        names.join(", ")
                    ),
                ));
            }
        };
        let item = &list[index];
        shown.push(item.title.clone());
        let last = depth + 1 == path.len();
        match (item.submenu, last) {
            (Some(submenu), false) => {
                prepare(hwnd, submenu, index);
                menu = submenu;
            }
            (Some(submenu), true) => {
                prepare(hwnd, submenu, index);
                let names: Vec<String> = items(submenu).into_iter().map(|i| i.title).collect();
                return Err(CuError::new(
                    "menu_open",
                    format!(
                        "{} is a submenu. Add one of its items to the path: {}.",
                        shown.join(" › "),
                        names.join(", ")
                    ),
                ));
            }
            (None, false) => {
                return Err(CuError::new(
                    "menu_not_found",
                    format!("{} is a command, not a submenu.", shown.join(" › ")),
                ))
            }
            (None, true) => {
                if item.disabled {
                    return Err(CuError::new(
                        "action_failed",
                        format!("{} is disabled right now.", shown.join(" › ")),
                    ));
                }
                return Ok((item.id, shown));
            }
        }
    }
    Err(CuError::new(
        "bad_action",
        "menu needs a path such as [\"File\", \"Save\"].",
    ))
}

/// The enabled menu command bound to a key chord, searched through the menu bar.
pub fn accelerator(hwnd: HWND, chord: &Chord) -> Option<(u32, Vec<String>)> {
    fn search(
        hwnd: HWND,
        menu: HMENU,
        chord: &Chord,
        path: &mut Vec<String>,
        depth: usize,
    ) -> Option<(u32, Vec<String>)> {
        for (index, item) in items(menu).into_iter().enumerate() {
            path.push(item.title.clone());
            if let Some(submenu) = item.submenu {
                if depth < 3 {
                    prepare(hwnd, submenu, index);
                    if let Some(found) = search(hwnd, submenu, chord, path, depth + 1) {
                        return Some(found);
                    }
                }
            } else if !item.disabled
                && item
                    .accelerator
                    .as_deref()
                    .and_then(parse_accelerator)
                    .is_some_and(|bound| same_keys(&bound, chord))
            {
                return Some((item.id, path.clone()));
            }
            path.pop();
        }
        None
    }
    let menu = bar(hwnd)?;
    search(hwnd, menu, chord, &mut Vec::new(), 0)
}

pub fn post_command(hwnd: HWND, id: u32) -> CuResult<()> {
    unsafe { PostMessageW(hwnd, WM_COMMAND, WPARAM(id as usize & 0xFFFF), LPARAM(0)) }.map_err(
        |e| {
            CuError::new(
                "action_failed",
                format!("Windows did not deliver the menu command: {e}"),
            )
        },
    )
}
