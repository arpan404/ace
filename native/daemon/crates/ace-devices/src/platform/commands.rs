// SPDX-License-Identifier: Apache-2.0
//! `commands.ts`: how a device is named and how an SDK command's arguments and output are
//! spelled. Same strings, same quoting, same bounds; the caller still runs the command.

use super::{Error, Platform, Refusal};

/// The AVD name `AppDevice.id` carries: one path-free token, as `emulator -list-avds` prints it.
const AVD_MAX: usize = 256;
/// `adb devices -l` lists at most this many emulator names per read.
const AVD_NAMES_MAX: usize = 1024;
/// `wm size` reports at most 32768 points on a side.
const DIMENSION_MAX: u32 = 32768;

fn is_avd(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= AVD_MAX
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

fn is_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        let separator = matches!(index, 8 | 13 | 18 | 23);
        if separator {
            if *byte != b'-' {
                return false;
            }
        } else if !byte.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

/// `nativeId`: the UDID or the AVD name behind an `AppDevice.id`, refused when they disagree.
pub fn native_id(id: &str, platform: Platform) -> Result<String, Error> {
    let text = match platform {
        Platform::Ios => id.strip_prefix("ios:"),
        Platform::Android => id.strip_prefix("android:"),
    };
    let Some(text) = text else {
        return Err(Refusal::word("identityPlatformMismatch").into());
    };
    match platform {
        Platform::Ios if is_uuid(text) => Ok(text.to_string()),
        Platform::Ios => Err(Refusal::word("identityNotUdid").into()),
        Platform::Android if is_avd(text) => Ok(text.to_string()),
        Platform::Android => Err(Refusal::word("identityNotAvd").into()),
    }
}

/// `avdNames`: the AVD names `emulator -list-avds` prints, trimmed, blank lines dropped.
pub fn avd_names(output: &str) -> Result<Vec<String>, Error> {
    let names: Vec<String> = output
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    if names.len() > AVD_NAMES_MAX || names.iter().any(|name| !is_avd(name)) {
        return Err(Error::Invalid(
            "emulator -list-avds printed a name that is not an AVD".into(),
        ));
    }
    Ok(names)
}

/// `avdNameOrUndefined`: an emulator property's first line, when it names an AVD.
pub fn avd_name(output: &str) -> Option<String> {
    let first = output.split('\n').next().unwrap_or_default().trim();
    is_avd(first).then(|| first.to_string())
}

/// `adbShell`: adb joins its arguments before the device's shell reads them, so each token is
/// quoted and every single quote inside it is escaped as `'\''`.
pub fn adb_shell(tokens: &[String]) -> Vec<String> {
    let joined = tokens
        .iter()
        .map(|token| format!("'{}'", token.replace('\'', "'\\''")))
        .collect::<Vec<_>>()
        .join(" ");
    vec!["shell".to_string(), joined]
}

/// The `wm size` line labelled `label`, exactly as `wm size` prints it.
fn size_line<'a>(output: &'a str, label: &str) -> Option<&'a str> {
    output.split('\n').find_map(|line| {
        line.strip_prefix(label)
            .filter(|rest| !rest.contains(' '))
            .filter(|rest| rest.contains('x'))
    })
}

fn parse_size(text: &str) -> Option<(u32, u32)> {
    let (width, height) = text.split_once('x')?;
    if !width.bytes().all(|byte| byte.is_ascii_digit())
        || !height.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let (Ok(width), Ok(height)) = (width.parse::<u32>(), height.parse::<u32>()) else {
        return None;
    };
    if (1..=DIMENSION_MAX).contains(&width) && (1..=DIMENSION_MAX).contains(&height) {
        return Some((width, height));
    }
    None
}

/// `androidDimensions`: `wm size`'s override when one is set, else its physical size. An
/// override `wm size` printed but ace cannot read fails the read instead of quietly answering
/// with the physical size, which would put every touch at the wrong point.
pub fn android_dimensions(output: &str) -> Result<(u32, u32), Error> {
    let printed =
        size_line(output, "Override size: ").or_else(|| size_line(output, "Physical size: "));
    match printed.and_then(parse_size) {
        Some(size) => Ok(size),
        None => Err(Refusal::word("sizeUndecoded").into()),
    }
}

/// `simulatorRuntime`: `"com.apple.CoreSimulator.SimRuntime.iOS-18-0"` as a person reads it.
pub fn simulator_runtime(identifier: &str) -> String {
    let Some(start) = identifier.rfind("SimRuntime.") else {
        return identifier.to_string();
    };
    let rest = &identifier[start + "SimRuntime.".len()..];
    let Some((name, version)) = rest.split_once('-') else {
        return identifier.to_string();
    };
    if name.is_empty() || !name.bytes().all(|byte| byte.is_ascii_alphabetic()) {
        return identifier.to_string();
    }
    let parts: Vec<&str> = version.split('-').collect();
    if parts.is_empty()
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return identifier.to_string();
    }
    format!("{name} {}", parts.join("."))
}

/// `simctl launch`'s process id: the trailing `: 1234` of its output.
pub fn launch_pid(stdout: &str) -> Option<String> {
    let line = stdout.trim_end();
    let (_, digits) = line.rsplit_once(':')?;
    let digits = digits.trim();
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(digits.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn an_id_carries_its_platform_and_the_udid_or_avd_it_names() {
        let udid = "11111111-1111-4111-8111-111111111111";
        assert_eq!(
            native_id(&format!("ios:{udid}"), Platform::Ios).expect("a UDID"),
            udid
        );
        assert_eq!(
            native_id("android:Pixel_API_35", Platform::Android).expect("an AVD"),
            "Pixel_API_35"
        );
    }

    #[test]
    fn an_id_for_the_other_platform_or_the_wrong_shape_is_refused() {
        let mismatch = native_id("android:Pixel_API_35", Platform::Ios).expect_err("mismatch");
        assert!(matches!(
            mismatch,
            Error::Refused(Refusal { message, .. }) if message == "Device identity does not match its platform"
        ));
        let avd = native_id("ios:not-a-udid", Platform::Ios).expect_err("not a UDID");
        assert!(
            matches!(avd, Error::Refused(Refusal { code, .. }) if code.as_str() == "invalid_data")
        );
        let shell =
            native_id("android:Pixel; rm -rf /", Platform::Android).expect_err("not an AVD");
        assert!(
            matches!(shell, Error::Refused(Refusal { message, .. }) if message == "Android device identity is not an AVD name")
        );
    }

    #[test]
    fn adb_shell_quotes_every_token_and_escapes_single_quotes() {
        assert_eq!(
            adb_shell(&tokens(&["input", "text", "a';$(echo unsafe) & b"])),
            vec!["shell", "'input' 'text' 'a'\\'';$(echo unsafe) & b'"]
        );
        assert_eq!(
            adb_shell(&tokens(&["am", "start", "-n", "dev.example/.Main"])),
            vec!["shell", "'am' 'start' '-n' 'dev.example/.Main'"]
        );
    }

    #[test]
    fn an_override_size_wins_over_the_physical_one() {
        assert_eq!(
            android_dimensions("Physical size: 1080x2400").expect("physical"),
            (1080, 2400)
        );
        assert_eq!(
            android_dimensions("Physical size: 1080x2400\nOverride size: 720x1600")
                .expect("override"),
            (720, 1600)
        );
    }

    #[test]
    fn a_size_that_is_missing_or_impossible_is_refused_rather_than_guessed() {
        for output in ["", "Physical size: 0x2400", "Physical size: 40000x10"] {
            let refused = android_dimensions(output).expect_err(output);
            assert!(
                matches!(refused, Error::Refused(Refusal { message, .. }) if message == "Android display size could not be decoded")
            );
        }
    }

    #[test]
    fn a_runtime_identifier_reads_as_a_release_name() {
        assert_eq!(
            simulator_runtime("com.apple.CoreSimulator.SimRuntime.iOS-18-0"),
            "iOS 18.0"
        );
        assert_eq!(
            simulator_runtime("com.apple.CoreSimulator.SimRuntime.iOS-26-5"),
            "iOS 26.5"
        );
        assert_eq!(
            simulator_runtime("com.apple.CoreSimulator.SimRuntime.watchOS-11"),
            "watchOS 11"
        );
        assert_eq!(simulator_runtime("custom"), "custom");
    }

    #[test]
    fn avd_names_trim_lines_and_drop_blanks() {
        assert_eq!(
            avd_names("Pixel_API_35\n\n  Tablet_API_34  \n").expect("names"),
            vec!["Pixel_API_35", "Tablet_API_34"]
        );
        assert!(avd_names("Pixel_API_35\nnot an avd\n").is_err());
    }

    #[test]
    fn an_emulator_property_names_an_avd_or_nothing() {
        assert_eq!(
            avd_name("Pixel_API_35\nOK\n"),
            Some("Pixel_API_35".to_string())
        );
        assert_eq!(avd_name("ERROR: unknown command\n"), None);
        assert_eq!(avd_name(""), None);
    }

    #[test]
    fn a_launch_pid_is_read_only_from_the_end_of_the_output() {
        assert_eq!(launch_pid("dev.example: 1234\n"), Some("1234".to_string()));
        assert_eq!(launch_pid("dev.example: 1234: 12"), Some("12".to_string()));
        assert_eq!(launch_pid("dev.example: pid\n"), None);
        assert_eq!(launch_pid(""), None);
    }
}
