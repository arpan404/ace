//! The Start menu's apps (the shell's AppsFolder) and launching them. Shell objects want a
//! single-threaded apartment, so each call runs on its own short-lived STA thread.
use super::catalog::executable_id;
use super::error::{CuError, CuResult};
use std::sync::mpsc;
use std::time::Duration;
use windows::core::{w, Interface, HSTRING, PCWSTR};
use windows::Win32::{
    Storage::EnhancedStorage::PKEY_Link_TargetParsingPath,
    System::Com::*,
    UI::{Shell::*, WindowsAndMessaging::SW_SHOWNOACTIVATE},
};

#[derive(Clone, Debug)]
pub struct StartApp {
    pub id: String,
    pub name: String,
    /// What `shell:AppsFolder\…` launches: an AppUserModelID or a known-folder path.
    pub parsing: String,
}

fn on_sta<T: Send + 'static>(
    timeout: Duration,
    work: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || unsafe {
        let initialized =
            CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).is_ok();
        let _ = sender.send(work());
        if initialized {
            CoUninitialize();
        }
    });
    receiver.recv_timeout(timeout).ok()
}

fn display_name(item: &IShellItem, kind: SIGDN) -> Option<String> {
    unsafe {
        let name = item.GetDisplayName(kind).ok()?;
        let text = name.to_string().ok();
        CoTaskMemFree(Some(name.0 as *const _));
        text
    }
}

fn enumerate() -> Vec<StartApp> {
    let mut apps = Vec::new();
    unsafe {
        let Ok(folder) =
            SHCreateItemFromParsingName::<_, _, IShellItem>(w!("shell:AppsFolder"), None)
        else {
            return apps;
        };
        let Ok(items) = folder.BindToHandler::<_, IEnumShellItems>(None, &BHID_EnumItems) else {
            return apps;
        };
        loop {
            let mut batch = [None];
            let mut fetched = 0u32;
            if items.Next(&mut batch, Some(&mut fetched)).is_err() || fetched == 0 {
                break;
            }
            let Some(item) = batch[0].take() else { break };
            let (Some(name), Some(parsing)) = (
                display_name(&item, SIGDN_NORMALDISPLAY),
                display_name(&item, SIGDN_PARENTRELATIVEPARSING),
            ) else {
                continue;
            };
            let target = item
                .cast::<IShellItem2>()
                .ok()
                .and_then(|item| item.GetString(&PKEY_Link_TargetParsingPath).ok())
                .and_then(|text| {
                    let value = text.to_string().ok();
                    CoTaskMemFree(Some(text.0 as *const _));
                    value
                });
            // Shortcuts that open a folder point at explorer.exe; they are not apps.
            if target
                .as_deref()
                .is_some_and(|path| executable_id(path) == "explorer.exe")
            {
                continue;
            }
            let id = match &target {
                Some(path) if path.to_lowercase().ends_with(".exe") => executable_id(path),
                // File Explorer's entry names the shell, not an executable.
                _ if parsing.eq_ignore_ascii_case("Microsoft.Windows.Explorer") => {
                    "explorer.exe".to_owned()
                }
                _ if parsing.contains('!') && !parsing.contains('\\') => parsing.clone(),
                _ if parsing.to_lowercase().ends_with(".exe") => executable_id(&parsing),
                _ => continue,
            };
            apps.push(StartApp { id, name, parsing });
            if apps.len() >= 2000 {
                break;
            }
        }
    }
    apps
}

/// The Start menu's apps. Empty when the shell does not answer within five seconds.
pub fn start_apps() -> Vec<StartApp> {
    on_sta(Duration::from_secs(5), enumerate).unwrap_or_default()
}

/// Starts an app without activating it: a Start entry through `shell:AppsFolder`, or an
/// executable by path.
pub fn launch(target: String, name: String) -> CuResult<()> {
    let outcome = on_sta(Duration::from_secs(15), move || unsafe {
        let file = HSTRING::from(target.as_str());
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
            lpFile: PCWSTR(file.as_ptr()),
            nShow: SW_SHOWNOACTIVATE.0,
            ..Default::default()
        };
        ShellExecuteExW(&mut info).map_err(|e| e.to_string())
    });
    match outcome {
        Some(Ok(())) => Ok(()),
        Some(Err(error)) => Err(CuError::new(
            "launch_failed",
            format!("Windows could not start {name}: {error}"),
        )),
        None => Err(CuError::new(
            "launch_failed",
            format!("Windows did not start {name} within 15 seconds."),
        )),
    }
}
