// SPDX-License-Identifier: Apache-2.0
//! `android-skin-files.ts`: finding an emulator's skin. The AVD's config names it (`skin.path`,
//! `skin.name`, or the hardware profile `hw.device.name`), and it lives under the SDK's `skins`
//! directory or the system image's. Every root and read is passed in: nothing here touches the
//! filesystem.

use super::paths::join;

/// An `.ini` file's `key=value` lines, later duplicates replacing earlier ones.
pub fn ini_values(text: &str) -> Vec<(String, String)> {
    let mut values: Vec<(String, String)> = Vec::new();
    for raw in text.split('\n') {
        let line = raw.trim_end_matches('\r');
        let Some((key, value)) = ini_pair(line) else {
            continue;
        };
        match values.iter_mut().find(|(existing, _)| *existing == key) {
            Some((_, existing)) => *existing = value.to_string(),
            None => values.push((key.to_string(), value.to_string())),
        }
    }
    values
}

/// `^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$`: a key that isn't a comment, and its value.
fn ini_pair(line: &str) -> Option<(&str, &str)> {
    let start = line.find(|character: char| !character.is_whitespace())?;
    let rest = &line[start..];
    let equals = rest.find('=')?;
    let key = rest[..equals].trim_end_matches(char::is_whitespace);
    if key.is_empty() || key.starts_with('#') {
        return None;
    }
    Some((key, rest[equals + 1..].trim_matches(char::is_whitespace)))
}

/// A name ace turns into a path: letters, digits, and `.`, `_` and `-`, never `.` or `..`.
pub fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "_.-".contains(character))
}

fn value<'a>(values: &'a [(String, String)], key: &str) -> Option<&'a str> {
    values
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.as_str())
}

/// Image bytes larger than this aren't read (the chrome travels in one message).
pub const IMAGE_LIMIT: usize = 700 * 1024;

/// An image's data URL: a PNG by its name, a WebP otherwise, as the skin names it.
pub fn image_url(bytes: &[u8], file: &str) -> String {
    use base64::Engine as _;
    let kind = match file.to_lowercase().ends_with(".png") {
        true => "png",
        false => "webp",
    };
    format!(
        "data:image/{kind};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// The AVD's config: the `.avd` folder an `.ini` pointer names first, then the folder beside the
/// pointer, root by root in the order given. An AVD whose name isn't a plain name names no config.
pub fn avd_config(
    avd: &str,
    avd_roots: &[String],
    read: &dyn Fn(&str) -> Option<String>,
) -> Option<Vec<(String, String)>> {
    if !plain_name(avd) {
        return None;
    }
    for root in avd_roots {
        let pointer = read(&join(&[root, &format!("{avd}.ini")]));
        let pointer = pointer.as_deref().map(ini_values);
        let pointed = pointer
            .as_ref()
            .and_then(|values| value(values, "path"))
            .filter(|path| is_absolute(path));
        let directories: Vec<String> = pointed
            .map(str::to_string)
            .into_iter()
            .chain([join(&[root, &format!("{avd}.avd")])])
            .collect();
        for directory in directories {
            let config = read(&join(&[&directory, "config.ini"]));
            if let Some(config) = config {
                return Some(ini_values(&config));
            }
        }
    }
    None
}

/// The directories a skin could live in: the config's absolute `skin.path` first, then each
/// SDK root with the config's relative path or a named skin, and the system image's skins.
pub fn skin_directories(config: &[(String, String)], sdk_roots: &[String]) -> Vec<String> {
    let path = value(config, "skin.path");
    let names: Vec<&str> = [value(config, "skin.name"), value(config, "hw.device.name")]
        .into_iter()
        .flatten()
        .filter(|name| plain_name(name) && *name != "_no_skin")
        .collect();
    let system_image = value(config, "image.sysdir.1");
    let mut candidates: Vec<String> = Vec::new();
    if let Some(path) = path.filter(|path| is_absolute(path)) {
        candidates.push(path.to_string());
    }
    let climbs = |path: &str| path.split(['/', '\\']).any(|part| part == "..");
    for root in sdk_roots {
        if let Some(path) = path.filter(|path| !is_absolute(path) && !climbs(path)) {
            candidates.push(join(&[root, path]));
        }
        for name in &names {
            candidates.push(join(&[root, "skins", name]));
            if let Some(image) = system_image.filter(|image| !climbs(image)) {
                candidates.push(join(&[root, image, "skins", name]));
            }
        }
    }
    let mut unique: Vec<String> = Vec::new();
    for candidate in candidates {
        if !unique.contains(&candidate) {
            unique.push(candidate);
        }
    }
    unique
}

/// `path.join` for this machine's separator, without resolving anything: every step is a name
/// or a path the caller supplied.
fn is_absolute(path: &str) -> bool {
    std::path::Path::new(path).is_absolute()
}

/// The first skin directory with a `layout` file, and that file's text.
pub fn skin_layout(
    directories: &[String],
    read: &dyn Fn(&str) -> Option<String>,
) -> Option<(String, String)> {
    for directory in directories {
        if let Some(layout) = read(&join(&[directory, "layout"])) {
            return Some((directory.clone(), layout));
        }
    }
    None
}

#[cfg(test)]
mod tests;

/// A config read as far as the files read so far allow.
pub enum ConfigStep {
    /// Config files whose text the read still needs, in the order it needs them.
    Read(Vec<String>),
    /// The AVD's config, as `avd_config` reads it once every file is present.
    Config(Vec<(String, String)>),
}

/// `avd_config` as a step: the config when the files read so far hold it, else what to read.
/// A file asked for but not yet read (`None`) blocks the candidates after it, so the folder the
/// AVD's pointer names wins over the one beside it; an answer the shell reports as empty was
/// read and held nothing, and the next candidate is tried.
pub fn avd_config_step(
    avd: &str,
    avd_roots: &[String],
    read: &dyn Fn(&str) -> Option<String>,
) -> ConfigStep {
    // An AVD whose name isn't a plain name names no config, and nothing more to read.
    if !plain_name(avd) {
        return ConfigStep::Read(Vec::new());
    }
    let mut missing: Vec<String> = Vec::new();
    for root in avd_roots {
        let pointer_path = join(&[root, &format!("{avd}.ini")]);
        let pointer = match read(&pointer_path) {
            Some(text) => Some(ini_values(&text)),
            None => {
                missing.push(pointer_path);
                None
            }
        };
        let pointed = pointer
            .as_ref()
            .and_then(|values| value(values, "path"))
            .filter(|path| is_absolute(path))
            .map(str::to_string);
        let directories: Vec<String> = pointed
            .into_iter()
            .chain([join(&[root, &format!("{avd}.avd")])])
            .collect();
        for directory in directories {
            let config_path = join(&[&directory, "config.ini"]);
            match read(&config_path) {
                // A config this root holds wins only once every earlier candidate was read.
                Some(config) if !config.is_empty() => {
                    return match missing.is_empty() {
                        true => ConfigStep::Config(ini_values(&config)),
                        false => ConfigStep::Read(missing),
                    };
                }
                Some(_) => {}
                None => missing.push(config_path),
            }
        }
    }
    ConfigStep::Read(missing)
}

/// A layout read as far as the files read so far allow.
pub enum LayoutStep {
    /// Layout files whose text the read still needs, in the order it needs them.
    Read(Vec<String>),
    /// The first skin directory with a layout, and that layout's text.
    Layout(String, String),
}

/// `skin_layout` as a step: the layout when the files read so far hold it, else what to read.
/// A folder whose layout isn't read yet blocks the folders after it, in the order given.
pub fn skin_layout_step(
    directories: &[String],
    read: &dyn Fn(&str) -> Option<String>,
) -> LayoutStep {
    let mut missing: Vec<String> = Vec::new();
    for directory in directories {
        let layout_path = join(&[directory, "layout"]);
        match read(&layout_path) {
            // A layout reads as the answer only once every folder before it was read.
            Some(layout) if !layout.is_empty() => {
                return match missing.is_empty() {
                    true => LayoutStep::Layout(directory.clone(), layout),
                    false => LayoutStep::Read(missing),
                };
            }
            Some(_) => {}
            None => missing.push(layout_path),
        }
    }
    LayoutStep::Read(missing)
}
