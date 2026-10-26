//! Which executables computer use may start or drive by path. Agents get windowed apps, not
//! anything that runs typed commands or other programs: a console program, a shell, a script
//! host or an interpreter would run commands outside the provider's own approvals. A renamed
//! copy is caught by its PE header and the original file name in its version resource. Pure.

/// IMAGE_SUBSYSTEM_WINDOWS_GUI.
pub const GUI: u16 = 2;
/// IMAGE_SUBSYSTEM_WINDOWS_CUI.
pub const CONSOLE: u16 = 3;

/// The subsystem field of a PE image's optional header, from the file's first bytes.
pub fn subsystem(head: &[u8]) -> Option<u16> {
    if head.get(..2)? != b"MZ" {
        return None;
    }
    let pe = u32::from_le_bytes(head.get(0x3C..0x40)?.try_into().ok()?) as usize;
    if head.get(pe..pe + 4)? != b"PE\0\0" {
        return None;
    }
    // The optional header follows the 4-byte signature and the 20-byte file header; the
    // subsystem sits at offset 68 in both PE32 and PE32+.
    let field = pe + 4 + 20 + 68;
    Some(u16::from_le_bytes(
        head.get(field..field + 2)?.try_into().ok()?,
    ))
}

/// Programs that run commands, scripts or other programs, by their file name.
fn runs_commands(name: &str) -> bool {
    const NAMES: &[&str] = &[
        "cmd.exe",
        "powershell.exe",
        "powershell_ise.exe",
        "pwsh.exe",
        "wt.exe",
        "windowsterminal.exe",
        "openconsole.exe",
        "conhost.exe",
        "bash.exe",
        "sh.exe",
        "wsl.exe",
        "wslhost.exe",
        "mintty.exe",
        "git-bash.exe",
        "ssh.exe",
        "putty.exe",
        "plink.exe",
        "rundll32.exe",
        "regsvr32.exe",
        "msiexec.exe",
        "mshta.exe",
        "wscript.exe",
        "cscript.exe",
        "scriptrunner.exe",
        "pcalua.exe",
        "presentationhost.exe",
        "cmstp.exe",
        "msbuild.exe",
        "installutil.exe",
        "regasm.exe",
        "regsvcs.exe",
        "msxsl.exe",
        "odbcconf.exe",
        "certutil.exe",
        "bitsadmin.exe",
        "schtasks.exe",
        "at.exe",
        "sc.exe",
        "reg.exe",
        "wmic.exe",
        "forfiles.exe",
        "hh.exe",
        "runas.exe",
        "explorer.exe",
        "taskmgr.exe",
        "py.exe",
        "pyw.exe",
        "node.exe",
        "deno.exe",
        "bun.exe",
        "java.exe",
        "javaw.exe",
        "ruby.exe",
        "rubyw.exe",
        "perl.exe",
        "php.exe",
        "lua.exe",
        "tclsh.exe",
        "wish.exe",
        "osascript.exe",
        "curl.exe",
        "ftp.exe",
        "tftp.exe",
    ];
    let name = name.trim().to_lowercase();
    let name = name.strip_suffix(".mui").unwrap_or(&name);
    NAMES.contains(&name) || name.starts_with("python")
}

/// Why computer use won't start this executable by path, or None when it may.
/// `file` is its file name, `original` the original file name from its version resource.
pub fn refusal(file: &str, original: Option<&str>, subsystem: Option<u16>) -> Option<String> {
    let shown = file.trim();
    if runs_commands(file) || original.is_some_and(runs_commands) {
        return Some(format!(
            "{shown} runs commands or other programs, so computer use does not start or operate it. Use your shell tool, which goes through your approvals."
        ));
    }
    match subsystem {
        Some(GUI) => None,
        Some(CONSOLE) => Some(format!(
            "{shown} is a console program; computer use only starts windowed apps. Use your shell tool for console programs."
        )),
        _ => Some(format!(
            "{shown} is not a windowed Windows app computer use can start."
        )),
    }
}

/// Why computer use won't operate this running program, or None: renamed shells and
/// interpreters are caught by their original file name.
pub fn running_refusal(file: &str, original: Option<&str>) -> Option<String> {
    (runs_commands(file) || original.is_some_and(runs_commands)).then(|| {
        format!(
            "{} runs commands or other programs, so computer use does not operate it. Use your shell tool, which goes through your approvals.",
            file.trim()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(subsystem: u16) -> Vec<u8> {
        let mut bytes = vec![0u8; 0x200];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[0x3C..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        bytes[0x80..0x84].copy_from_slice(b"PE\0\0");
        let field = 0x80 + 4 + 20 + 68;
        bytes[field..field + 2].copy_from_slice(&subsystem.to_le_bytes());
        bytes
    }

    #[test]
    fn the_subsystem_is_read_from_the_pe_header() {
        assert_eq!(subsystem(&image(GUI)), Some(GUI));
        assert_eq!(subsystem(&image(CONSOLE)), Some(CONSOLE));
        assert_eq!(subsystem(b"#!/bin/sh"), None);
        assert_eq!(subsystem(&image(GUI)[..0x90]), None);
    }

    #[test]
    fn only_windowed_apps_start_by_path() {
        assert_eq!(refusal("fixture.exe", Some("fixture.exe"), Some(GUI)), None);
        assert!(refusal("tool.exe", None, Some(CONSOLE))
            .unwrap()
            .contains("console program"));
        assert!(refusal("data.exe", None, None).is_some());
    }

    #[test]
    fn renamed_shells_and_interpreters_are_refused_by_their_original_name() {
        assert!(refusal("notes.exe", Some("PowerShell.EXE.MUI"), Some(GUI)).is_some());
        assert!(refusal("helper.exe", Some("pythonw.exe"), Some(GUI)).is_some());
        assert!(refusal("rundll32.exe", None, Some(GUI)).is_some());
        assert!(refusal("MSHTA.EXE", None, Some(GUI)).is_some());
        assert!(running_refusal("editor.exe", Some("cmd.exe")).is_some());
        assert_eq!(
            running_refusal("notepad.exe", Some("NOTEPAD.EXE.MUI")),
            None
        );
    }
}
