// SPDX-License-Identifier: Apache-2.0
//! `simulator-chrome-files.ts`'s reading: which device type bundle `simctl` lists, the chrome
//! bundle a device type wears, and where a PDF a chrome names lives. Pure: the JSON and the
//! roots come in, paths and names go out.

use ace_json::Value;

use super::paths::join;

/// A resource name from Apple's files is a plain file name, never a path.
pub fn plain_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', '\0'])
}

/// The device type's bundle from `xcrun simctl list devicetypes --json`, or none when the type
/// isn't listed or the answer isn't the shape ace reads.
pub fn device_type_bundle(text: &str, identifier: &str) -> Option<String> {
    let value = ace_json::parse(text).ok()?;
    let types = value.as_object()?.get("devicetypes")?.as_array()?;
    if types.len() > 4096 {
        return None;
    }
    types
        .iter()
        .filter_map(|entry| {
            let entry = entry.as_object()?;
            let identifier = entry.get("identifier")?.as_str()?;
            let bundle_path = entry.get("bundlePath")?.as_str()?;
            match identifier.chars().count() <= 512 && bundle_path.chars().count() <= 4096 {
                true => Some((identifier, bundle_path)),
                false => None,
            }
        })
        .find(|(listed, _)| *listed == identifier)
        .map(|(_, bundle_path)| bundle_path.to_string())
}

/// The chrome bundles a profile's identifier could live in, in the order ace looks: the folder
/// named by the identifier's last component under each root.
pub fn chrome_bundles(identifier: &str, roots: &[String]) -> Vec<String> {
    let last = identifier.rsplit('.').next().unwrap_or_default();
    if !plain_name(last) {
        return Vec::new();
    }
    roots
        .iter()
        .map(|root| join(&[root, &format!("{last}.devicechrome")]))
        .collect()
}

/// The bundle's own resources and its chrome's resources: where the PDFs a chrome names live.
pub fn resource_directories(bundle: &str, chrome_directory: &str) -> (String, String) {
    (
        join(&[bundle, "Contents/Resources"]),
        join(&[chrome_directory, "Contents/Resources"]),
    )
}

/// A PDF a chrome names, inside the bundle it comes from; none when the name isn't a plain file.
pub fn art_path(resources: &str, chrome_resources: &str, from: bool, name: &str) -> Option<String> {
    if !plain_name(name) {
        return None;
    }
    let directory = match from {
        true => chrome_resources,
        false => resources,
    };
    Some(join(&[directory, &format!("{name}.pdf")]))
}

/// Whether a chrome bundle's `chrome.json` belongs to the identifier the profile named: a file
/// with no identifier, or one ace can't read, belongs to nobody in particular.
pub fn bundle_matches(text: &str, identifier: &str) -> bool {
    let Ok(value) = ace_json::parse(text) else {
        return true;
    };
    match crate::platform::simulator_chrome_file::identity(&value) {
        Some(own) => own == identifier,
        None => true,
    }
}

/// A JSON document's own value, for callers checking an answer's shape.
pub fn parse(text: &str) -> Option<Value> {
    ace_json::parse(text).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TYPES: &str = r#"{"devicetypes":[
      {"identifier":"com.apple.CoreSimulator.SimDeviceType.Test-Phone",
       "bundlePath":"/Xcode/Test Phone.simdevicetype","name":"x"}]}"#;

    #[test]
    fn a_device_types_bundle_is_the_one_simctl_lists() {
        assert_eq!(
            device_type_bundle(TYPES, "com.apple.CoreSimulator.SimDeviceType.Test-Phone")
                .as_deref(),
            Some("/Xcode/Test Phone.simdevicetype")
        );
        assert_eq!(
            device_type_bundle(TYPES, "com.apple.CoreSimulator.SimDeviceType.Other"),
            None
        );
        assert_eq!(device_type_bundle("not json", "com.apple.x"), None);
        assert_eq!(
            device_type_bundle(r#"{"devicetypes":"no"}"#, "com.apple.x"),
            None
        );
    }

    #[test]
    fn a_chromes_bundle_is_named_by_its_identifiers_last_component_under_each_root() {
        assert_eq!(
            chrome_bundles(
                "com.apple.dt.devicekit.chrome.testphone",
                &["/Chrome".to_string(), "/home/a/Chrome".to_string()]
            ),
            vec![
                "/Chrome/testphone.devicechrome".to_string(),
                "/home/a/Chrome/testphone.devicechrome".to_string()
            ]
        );
        // A last component that isn't a plain folder name names no bundle.
        assert!(chrome_bundles("com.apple..", &["/Chrome".to_string()]).is_empty());
    }

    #[test]
    fn a_resource_is_read_from_the_bundle_that_names_it_and_never_outside() {
        let (resources, chrome_resources) =
            resource_directories("/Xcode/Phone.simdevicetype", "/Chrome/test.devicechrome");
        assert_eq!(
            art_path(&resources, &chrome_resources, false, "MASK").as_deref(),
            Some("/Xcode/Phone.simdevicetype/Contents/Resources/MASK.pdf")
        );
        assert_eq!(
            art_path(&resources, &chrome_resources, true, "TL").as_deref(),
            Some("/Chrome/test.devicechrome/Contents/Resources/TL.pdf")
        );
        assert_eq!(
            art_path(&resources, &chrome_resources, false, "../../../../secret"),
            None
        );
    }

    #[test]
    fn a_bundle_belongs_to_the_identifier_the_profile_named() {
        assert!(bundle_matches(
            r#"{"identifier":"com.apple.dt.devicekit.chrome.testphone"}"#,
            "com.apple.dt.devicekit.chrome.testphone"
        ));
        assert!(!bundle_matches(
            r#"{"identifier":"com.apple.dt.devicekit.chrome.other"}"#,
            "com.apple.dt.devicekit.chrome.testphone"
        ));
        // A file ace can't read is tried as the chrome it might be.
        assert!(bundle_matches(
            "not json",
            "com.apple.dt.devicekit.chrome.testphone"
        ));
    }
}
