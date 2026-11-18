use serde_json::json;

use super::*;

/// ace's answer to `browser_tabs list`: (tab, url, current, loading).
fn tabs(listed: &[(&str, &str, bool, bool)]) -> String {
    let tabs: Vec<Value> = listed
        .iter()
        .map(|(tab, url, current, loading)| {
            let mut entry = json!({"tabId": tab, "url": url, "title": ""});
            if *current {
                entry["current"] = json!(true);
            }
            if *loading {
                entry["loading"] = json!(true);
            }
            entry
        })
        .collect();
    json!({ "tabs": tabs }).to_string()
}

fn in_tab(arguments: Value, answer: &str) -> Step {
    read("browser_act", &arguments, Some(answer))
}

fn host(step: &Step) -> Option<&str> {
    match &step.place {
        Ok(Place::Site { host, .. }) => Some(host),
        _ => None,
    }
}

/// `screen_apps`' answer listing these apps.
fn apps(rows: &[&str]) -> String {
    format!("Running:\n{}", rows.join("\n"))
}

fn screen(app: &str, answer: &str) -> Step {
    read("screen_act", &json!({"app": app}), Some(answer))
}

#[test]
fn a_step_without_a_tab_acts_in_the_current_tab_ace_lists_not_the_last_one_reported() {
    // Gmail is current; the bot last read an ordinary site in another tab.
    let answer = tabs(&[
        ("t1", "https://mail.google.com/mail/u/0", true, false),
        ("t2", "https://docs.rs/serde", false, false),
    ]);
    let step = in_tab(json!({"action": "click", "ref": "e1"}), &answer);
    assert_eq!(host(&step), Some("mail.google.com"));
    assert!(step.sensitive.is_some());
    let named = in_tab(
        json!({"action": "click", "ref": "e1", "tabId": "t2"}),
        &answer,
    );
    assert_eq!(host(&named), Some("docs.rs"));
    assert_eq!(named.sensitive, None);
    // A tab ace doesn't list, or no current tab: Spade can't tell.
    let gone = in_tab(json!({"action": "click", "tabId": "t9"}), &answer);
    assert_eq!(gone.place, Err(NO_TAB));
    let none_current = tabs(&[("t2", "https://docs.rs/serde", false, false)]);
    assert_eq!(in_tab(json!({}), &none_current).place, Err(NO_TAB));
    assert_eq!(
        read("browser_act", &json!({}), None).place,
        Err(NO_TAB),
        "ace couldn't answer"
    );
}

#[test]
fn back_navigation_and_redirects_are_read_from_the_tab_as_it_is_now() {
    // After Back from an ordinary page, the tab is on Gmail again.
    let back = tabs(&[("t1", "https://mail.google.com/mail/u/0", true, false)]);
    let step = read(
        "browser_history",
        &json!({"direction": "back"}),
        Some(&back),
    );
    assert!(step.sensitive.is_some());
    assert!(in_tab(json!({"action": "type"}), &back).sensitive.is_some());
    // A redirect still loading has no place yet.
    let redirecting = tabs(&[("t1", "https://shop.example.com/", true, true)]);
    assert_eq!(in_tab(json!({}), &redirecting).place, Err(LOADING));
    // A step's place changes when the tab does: the gate's and the run's readings differ.
    let before = in_tab(json!({}), &tabs(&[("t1", "https://docs.rs/", true, false)]));
    let after = in_tab(json!({}), &back);
    assert_ne!(before.place, after.place);
    // Opening an address is placed by where it goes, and a page that isn't web has no place.
    let opened = read(
        "browser_open",
        &json!({"url": "https://www.paypal.com/"}),
        None,
    );
    assert_eq!(host(&opened), Some("paypal.com"));
    let blank = tabs(&[("t1", "about:blank", true, false)]);
    assert_eq!(in_tab(json!({}), &blank).place, Err(NOT_WEB));
    // The lookup carries the call's routing, so it lists the same browser.
    assert_eq!(
        lookup(
            "browser_act",
            &json!({"machine": "mini", "browser": "user"})
        ),
        Lookup::Ask {
            tool: "browser_tabs",
            arguments: json!({"action": "list", "machine": "mini", "browser": "user"}),
        }
    );
}

#[test]
fn device_input_has_no_place_and_opening_a_sensitive_app_is_the_persons() {
    for action in [
        "tap",
        "type",
        "key",
        "swipe",
        "ui",
        "clipboard_get",
        "long_press",
    ] {
        let step = read("sim_act", &json!({"simId": "s1", "action": action}), None);
        assert_eq!(step.place, Err(DEVICE_INPUT), "{action}");
    }
    // After opening Mail, or switching from TextEdit to Settings, a tap is still unplaced.
    for app in [
        "com.apple.mobilemail",
        "com.apple.Preferences",
        "com.apple.mobilesafari",
        "com.google.android.gm",
    ] {
        let opened = read(
            "sim_act",
            &json!({"simId": "s1", "action": "open_app", "appId": app}),
            None,
        );
        assert!(opened.sensitive.is_some(), "{app}");
    }
    let calculator = read(
        "sim_act",
        &json!({"simId": "s1", "action": "open_app", "appId": "com.apple.calculator"}),
        None,
    );
    assert_eq!(calculator.sensitive, None);
    // No device place is ever granted: a grant for "Simulator" would cover every app on it.
    let Ok(place) = calculator.place else {
        panic!("open_app is placed by the app");
    };
    assert_eq!(place.grant(), None);
    let started = read("sim_start", &json!({"simId": "s1"}), None);
    assert_eq!(started.place.ok().and_then(|place| place.grant()), None);
}

#[test]
fn part_of_a_sensitive_apps_name_is_that_app() {
    for given in [
        "cord", "Discord", "lack", "Slack", "ail", "Mail", "chain", "Word",
    ] {
        assert!(
            sensitive::app_given(given).is_some(),
            "{given} may open a sensitive app"
        );
    }
    for given in ["TextEdit", "Calculator", "Notes", "Pages", "Figma", "Xcode"] {
        assert_eq!(sensitive::app_given(given), None, "{given}");
    }
}

#[test]
fn every_sensitive_word_has_a_name_that_holds_it() {
    for entry in sensitive::APPS {
        assert!(!entry.names.is_empty(), "{}", entry.word);
        assert!(
            entry
                .names
                .iter()
                .any(|name| name.to_lowercase().contains(entry.word)),
            "{} has no name holding it",
            entry.word
        );
    }
}

#[test]
fn an_app_is_every_app_ace_could_open_for_the_name() {
    let listed = apps(&[
        "Discord (com.hnc.Discord)",
        "TextEdit (com.apple.TextEdit), frontmost",
        "Notes (com.apple.Notes)",
        "Notion (notion.id)",
        "Acme Bank (com.acme.money)",
    ]);
    let edit = screen("TextEdit", &listed);
    assert_eq!(
        edit.place,
        Ok(Place::App {
            id: "com.apple.TextEdit".into(),
            name: "TextEdit".into()
        })
    );
    assert_eq!(edit.sensitive, None);
    // `acme` names no sensitive app, but ace could open Acme Bank for it.
    assert_eq!(sensitive::app_given("acme"), None);
    assert!(screen("acme", &listed).sensitive.is_some());
    // Two apps hold `no` and neither is named so: no place, so the person decides.
    assert_eq!(screen("no", &listed).place, Err(NO_APP));
    // No answer from ace: the name alone decides, and there is no place.
    let unanswered = read("screen_act", &json!({"app": "TextEdit"}), None);
    assert_eq!(unanswered.place, Err(NO_APP));
    assert!(
        read("screen_act", &json!({"app": "Mail"}), None)
            .sensitive
            .is_some()
    );
}

#[test]
fn hosts_are_read_as_a_browser_reads_them() {
    for url in [
        "https://%70aypal.com/",
        "https://ｐａｙｐａｌ.com/",
        "https://PAYPAL.com./",
        "https://www.paypal.com:443/",
        "https://user:pw@evil.example@paypal.com/",
        "https://example.com/#/settings",
        "https://example.com/app#!/account/security",
        "https://example.com/%73ettings/tokens",
        "https://example.com/%2573ettings",
    ] {
        assert!(site(url).sensitive.is_some(), "{url}");
    }
    for url in [
        "https://github.com/acme/app/pulls",
        "https://docs.rs/serde",
        "https://www.example.com/blog/how-to-buy-a-car",
        "http://localhost:3000/login",
        "http://127.0.0.1:5173/checkout",
        "https://example.com/#intro",
    ] {
        let step = site(url);
        assert!(step.place.is_ok() && step.sensitive.is_none(), "{url}");
    }
    for url in [
        "about:blank",
        "chrome://settings",
        "javascript:alert(1)",
        "x",
    ] {
        assert_eq!(site(url).place, Err(NOT_WEB), "{url}");
    }
}

#[test]
fn everyday_apps_are_left_to_the_reviewer_and_sensitive_ones_are_not() {
    for (name, id) in [
        ("TextEdit", "com.apple.TextEdit"),
        ("Calculator", "com.apple.calculator"),
        ("Archive Utility", "com.apple.archiveutility"),
        ("Text Editor", "org.gnome.TextEditor"),
        ("Figma", "com.figma.Desktop"),
    ] {
        let place = Place::App {
            id: id.into(),
            name: name.into(),
        };
        assert_eq!(sensitive(&place), None, "{name}");
    }
    for (name, id) in [
        ("Mail", "com.apple.mail"),
        ("Messages", "com.apple.MobileSMS"),
        ("Slack", "com.tinyspeck.slackmacgap"),
        ("Signal", "org.whispersystems.signal-desktop"),
        ("1Password 7", "com.agilebits.onepassword7"),
        ("Keychain Access", "com.apple.keychainaccess"),
        ("System Settings", "com.apple.systempreferences"),
        ("Settings", "gnome-control-center"),
        ("Safari", "com.apple.Safari"),
        ("Arc", "company.thebrowser.Browser"),
    ] {
        let place = Place::App {
            id: id.into(),
            name: name.into(),
        };
        assert!(sensitive(&place).is_some(), "{name}");
    }
}

#[test]
fn a_sensitive_app_or_site_cant_be_granted() {
    for app in ["com.apple.mail", "Mail", "cord", ""] {
        assert!(grantable_app(app).is_err(), "{app}");
    }
    assert_eq!(grantable_app("com.apple.TextEdit"), Ok(()));
    for host in [
        "paypal.com",
        "%70aypal.com",
        "ｐａｙｐａｌ.com",
        "mail.google.com",
        "",
    ] {
        assert!(grantable_site(host).is_err(), "{host}");
    }
    assert_eq!(grantable_site("github.com"), Ok(()));
}
