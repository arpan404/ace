// SPDX-License-Identifier: Apache-2.0
//! The cases `android-skin-files.test.ts` moved here: which config, skin folder and images a
//! skin read picks, and what it refuses to follow. Nothing here touches the filesystem.

use std::collections::HashMap;

use super::*;

/// A read that answers from a map, as the shell's `readFile` does.
fn files<'a>(entries: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
    let map: HashMap<String, String> = entries
        .iter()
        .map(|(path, text)| ((*path).to_string(), (*text).to_string()))
        .collect();
    move |path| map.get(path).cloned()
}

const ROOT: &str = "/ace/avd";
const SDK: &str = "/ace/sdk";

fn roots(root: &str) -> Vec<String> {
    vec![root.to_string()]
}

fn sdk() -> Vec<String> {
    vec![SDK.to_string()]
}

#[test]
fn an_ini_files_pairs_skip_comments_and_stray_lines() {
    let values = ini_values(
        "avd.ini.encoding=UTF-8\r\n  hw.device.name = pixel 7 \nskin.path=../x\n# c=1\nnonsense\n=nameless\n",
    );
    assert_eq!(
        values,
        vec![
            ("avd.ini.encoding".to_string(), "UTF-8".to_string()),
            ("hw.device.name".to_string(), "pixel 7".to_string()),
            ("skin.path".to_string(), "../x".to_string()),
        ]
    );
    // A later line wins, as the TypeScript's `Map.set` does.
    assert_eq!(
        ini_values("a=1\na=2\n"),
        vec![("a".to_string(), "2".to_string())]
    );
}

#[test]
fn an_avds_config_is_read_from_the_folder_its_pointer_names_first() {
    let read = files(&[
        ("/ace/avd/Pixel.ini", "path=/elsewhere/Pixel.avd\n"),
        (
            "/elsewhere/Pixel.avd/config.ini",
            "hw.device.name=pointed\n",
        ),
        ("/ace/avd/Pixel.avd/config.ini", "hw.device.name=beside\n"),
    ]);
    let config = avd_config("Pixel", &roots(ROOT), &read).expect("a config");
    assert_eq!(
        config,
        vec![("hw.device.name".to_string(), "pointed".to_string())]
    );
}

#[test]
fn an_avds_config_falls_back_to_the_folder_beside_its_pointer_and_the_next_root() {
    let read = files(&[
        ("/ace/avd/Pixel.ini", "path=/elsewhere/Pixel.avd\n"),
        ("/ace/avd/Pixel.avd/config.ini", "hw.device.name=beside\n"),
        ("/first/Pixel.avd/config.ini", "hw.device.name=earlier\n"),
    ]);
    let config = avd_config("Pixel", &roots(ROOT), &read).expect("a config");
    assert_eq!(
        config,
        vec![("hw.device.name".to_string(), "beside".to_string())]
    );
    let both = vec!["/first".to_string(), ROOT.to_string()];
    let config = avd_config("Pixel", &both, &read).expect("a config");
    assert_eq!(
        config,
        vec![("hw.device.name".to_string(), "earlier".to_string())]
    );
    assert_eq!(avd_config("Never_Made", &roots(ROOT), &read), None);
}

#[test]
fn a_skins_directories_are_its_absolute_path_then_the_sdks_named_skins() {
    let config = ini_values(
        "skin.path=/custom/skin\nskin.name=pixel_7\nhw.device.name=pixel_7\nimage.sysdir.1=system-images/android-36/x\n",
    );
    assert_eq!(
        skin_directories(&config, &sdk()),
        vec![
            "/custom/skin".to_string(),
            "/ace/sdk/skins/pixel_7".to_string(),
            "/ace/sdk/system-images/android-36/x/skins/pixel_7".to_string(),
        ]
    );
}

#[test]
fn an_avd_naming_a_skin_outside_the_sdk_by_a_relative_path_is_never_followed_there() {
    let config = ini_values("skin.path=../elsewhere\n");
    assert!(skin_directories(&config, &sdk()).is_empty());
    let config = ini_values("skin.path=..\\\\elsewhere\n");
    assert!(skin_directories(&config, &sdk()).is_empty());
}

#[test]
fn a_skin_name_that_is_not_a_plain_folder_is_not_searched_for() {
    let config = ini_values("skin.name=_no_skin\nhw.device.name=_no_skin\nskin.path=_no_skin\n");
    // `_no_skin` names no skin, but the path `_no_skin` is still the folder the config names.
    assert_eq!(
        skin_directories(&config, &sdk()),
        vec!["/ace/sdk/_no_skin".to_string()]
    );
    let odd = ini_values("hw.device.name=pixel 7\nskin.name=../../etc\n");
    assert!(skin_directories(&odd, &sdk()).is_empty());
}

#[test]
fn the_first_skin_folder_with_a_layout_is_the_one_read() {
    let read = files(&[
        ("/ace/sdk/skins/pixel_7/layout", "layouts {}\n"),
        ("/ace/sdk/skins/pixel_7/back.png", "png"),
    ]);
    let directories = vec![
        "/ace/sdk/skins/missing".to_string(),
        "/ace/sdk/skins/pixel_7".to_string(),
        "/ace/sdk/skins/later".to_string(),
    ];
    let (directory, layout) = skin_layout(&directories, &read).expect("a layout");
    assert_eq!(directory, "/ace/sdk/skins/pixel_7");
    assert_eq!(layout, "layouts {}\n");
    assert_eq!(
        skin_layout(&["/ace/sdk/skins/missing".to_string()], &read),
        None
    );
}

#[test]
fn a_skin_images_data_url_names_its_real_type() {
    assert_eq!(image_url(b"png", "back.png"), "data:image/png;base64,cG5n");
    assert_eq!(
        image_url(b"webp", "BACK.PNG"),
        "data:image/png;base64,d2VicA=="
    );
    assert_eq!(
        image_url(b"webp", "back.webp"),
        "data:image/webp;base64,d2VicA=="
    );
}

#[test]
fn a_config_read_asks_for_the_files_it_has_not_seen_and_answers_once_it_has() {
    let read = files(&[
        ("/ace/avd/Pixel.ini", "path=/elsewhere/Pixel.avd\n"),
        (
            "/elsewhere/Pixel.avd/config.ini",
            "hw.device.name=pointed\n",
        ),
    ]);
    let ConfigStep::Config(config) = avd_config_step("Pixel", &roots(ROOT), &read) else {
        panic!("every config file the read needs is present");
    };
    assert_eq!(
        config,
        vec![("hw.device.name".to_string(), "pointed".to_string())]
    );
    // With nothing read yet, the read names the pointer and the folder beside it.
    let nothing = |_: &str| None;
    match avd_config_step("Pixel", &roots(ROOT), &nothing) {
        ConfigStep::Read(paths) => assert_eq!(
            paths,
            vec![
                "/ace/avd/Pixel.ini".to_string(),
                "/ace/avd/Pixel.avd/config.ini".to_string()
            ]
        ),
        ConfigStep::Config(_) => panic!("nothing was read"),
    }
    // Once the pointer is read, the folder it names is asked for too.
    let pointer_only = files(&[("/ace/avd/Pixel.ini", "path=/elsewhere/Pixel.avd\n")]);
    match avd_config_step("Pixel", &roots(ROOT), &pointer_only) {
        ConfigStep::Read(paths) => assert_eq!(
            paths,
            vec![
                "/elsewhere/Pixel.avd/config.ini".to_string(),
                "/ace/avd/Pixel.avd/config.ini".to_string()
            ]
        ),
        ConfigStep::Config(_) => panic!("no config was read"),
    }
}

#[test]
fn a_layout_read_asks_for_each_skin_folders_layout_until_one_answers() {
    let directories = vec![
        "/ace/sdk/skins/missing".to_string(),
        "/ace/sdk/skins/pixel_7".to_string(),
    ];
    let nothing = |_: &str| None;
    match skin_layout_step(&directories, &nothing) {
        LayoutStep::Read(paths) => assert_eq!(
            paths,
            vec![
                "/ace/sdk/skins/missing/layout".to_string(),
                "/ace/sdk/skins/pixel_7/layout".to_string()
            ]
        ),
        LayoutStep::Layout(..) => panic!("nothing was read"),
    }
    // The shell reports a folder it read with no layout as empty text, not as unread.
    let read = files(&[
        ("/ace/sdk/skins/missing/layout", ""),
        ("/ace/sdk/skins/pixel_7/layout", "layouts {}\n"),
    ]);
    match skin_layout_step(&directories, &read) {
        LayoutStep::Layout(directory, layout) => {
            assert_eq!(directory, "/ace/sdk/skins/pixel_7");
            assert_eq!(layout, "layouts {}\n");
        }
        LayoutStep::Read(_) => panic!("the second folder has a layout"),
    }
}

#[test]
fn a_skin_plan_carries_the_corner_each_image_is_measured_from() {
    let layout = "parts {\n  device {\n    display {\n      width 1080\n      height 2400\n    }\n  }\n  portrait {\n    background {\n      image back.webp\n    }\n    foreground {\n      mask mask.png\n    }\n  }\n}\nlayouts {\n  portrait {\n    width 1200\n    height 2541\n    p1 {\n      name device\n      x 59\n      y 58\n    }\n    p2 {\n      name portrait\n      x 0\n      y 0\n    }\n  }\n}\n";
    let tree = crate::platform::android_skin::parse_skin_layout(layout);
    let opening = crate::platform::android_skin::opening(&tree).expect("an opening");
    let plan = opening.plan();
    assert_eq!(plan.back_corner, Some((59, 58)));
    assert_eq!(plan.reach, opening.reach());
    assert_eq!(plan.opening(), opening);
    assert_eq!(plan.background, "back.webp");
    assert_eq!(plan.mask.as_deref(), Some("mask.png"));
}

#[test]
fn an_avd_name_that_is_not_a_plain_name_names_no_config() {
    let read = files(&[("/ace/avd/../../x.ini", "path=/elsewhere/x.avd\n")]);
    assert_eq!(avd_config("../../x", &roots(ROOT), &read), None);
    match avd_config_step("../../x", &roots(ROOT), &read) {
        ConfigStep::Read(paths) => assert!(paths.is_empty(), "nothing more to read"),
        ConfigStep::Config(config) => panic!("an escaping name found a config: {config:?}"),
    }
}

#[test]
fn the_folder_an_avd_pointer_names_wins_over_the_one_beside_it() {
    // The pointer names an absolute folder, and that folder's config has not been read yet; the
    // folder beside it has one, but the read must ask for the pointed folder first.
    let read = files(&[
        ("/ace/avd/Pixel.ini", "path=/elsewhere/Pixel.avd\n"),
        ("/ace/avd/Pixel.avd/config.ini", "hw.device.name=beside\n"),
    ]);
    match avd_config_step("Pixel", &roots(ROOT), &read) {
        ConfigStep::Read(paths) => {
            assert_eq!(paths, vec!["/elsewhere/Pixel.avd/config.ini".to_string()]);
        }
        ConfigStep::Config(config) => panic!("the pointed folder was not read: {config:?}"),
    }
}

#[test]
fn a_skin_folder_not_read_yet_blocks_the_layouts_after_it() {
    let directories = vec![
        "/ace/sdk/skins/first".to_string(),
        "/ace/sdk/skins/second".to_string(),
    ];
    let read = files(&[("/ace/sdk/skins/second/layout", "layouts {}\n")]);
    match skin_layout_step(&directories, &read) {
        LayoutStep::Read(paths) => {
            assert_eq!(paths, vec!["/ace/sdk/skins/first/layout".to_string()]);
        }
        LayoutStep::Layout(..) => panic!("an earlier folder could still have the layout"),
    }
}
