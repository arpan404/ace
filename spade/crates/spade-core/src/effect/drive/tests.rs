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

/// A `browser_act` step (a click, unless the arguments say otherwise) in the tabs `answer`.
fn in_tab(mut arguments: Value, answer: &str) -> Step {
    if arguments.get("action").is_none() {
        arguments["action"] = json!("click");
    }
    read("browser_act", &arguments, Some(answer))
}

fn host(step: &Step) -> Option<&str> {
    match &step.place {
        Ok(Place::Site { page, .. }) => Some(&page.host),
        _ => None,
    }
}

fn tab_of(step: &Step) -> Option<&str> {
    match &step.place {
        Ok(Place::Site { tab, .. }) => tab.as_deref(),
        _ => None,
    }
}

fn grant(scope: crate::grant::Scope) -> crate::grant::Grant {
    crate::grant::Grant {
        id: "g".into(),
        scope,
        by: crate::grant::BY_PERSON.into(),
        created_at: 0,
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
        read("browser_act", &json!({"action": "click"}), None).place,
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
            &json!({"action": "click", "machine": "mini", "browser": "user"})
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

#[test]
fn a_dialog_answer_acts_in_the_tab_that_raised_the_dialog_whichever_tab_it_names() {
    let mut listed: Value = serde_json::from_str(&tabs(&[
        ("t1", "https://docs.rs/serde", true, false),
        ("t2", "https://mail.google.com/mail/u/0", false, false),
    ]))
    .unwrap_or_default();
    listed["tabs"][1]["pending_dialog"] = json!({"dialogId": "d7", "type": "confirm"});
    let answer = listed.to_string();
    let named_other = json!({"action": "dialog", "dialogId": "d7", "accept": true, "tabId": "t1"});
    let step = in_tab(named_other, &answer);
    assert_eq!(tab_of(&step), Some("t2"));
    assert!(step.sensitive.is_some(), "the dialog is Gmail's");
    let current = in_tab(
        json!({"action": "dialog", "dialogId": "d7", "accept": true}),
        &answer,
    );
    assert_eq!(tab_of(&current), Some("t2"));
    // A dialog no tab shows can't be placed.
    let gone = in_tab(
        json!({"action": "dialog", "dialogId": "d8", "accept": true}),
        &answer,
    );
    assert_eq!(gone.place, Err(NO_DIALOG));
}

#[test]
fn a_step_is_bound_to_its_tab_and_whole_address_and_a_query_route_counts() {
    // A route in the query is a route.
    for url in [
        "https://app.example.com/?view=settings",
        "https://app.example.com/home?tab=billing&x=1",
        "https://app.example.com/?next=%2Faccount%2Fsecurity",
    ] {
        assert!(site(url).sensitive.is_some(), "{url}");
    }
    // What someone searched for isn't where the page is.
    assert_eq!(
        site("https://www.google.com/search?q=checkout+bags").sensitive,
        None
    );
    let at = |url: &str, tab: &str| {
        in_tab(
            json!({"tabId": tab}),
            &tabs(&[(tab, url, true, false), ("other", url, false, false)]),
        )
        .place
    };
    let here = at("https://docs.example:8443/guide?x=1", "t1");
    // Another port, another query, the same address in another tab: another place.
    assert_ne!(here, at("https://docs.example:9443/guide?x=1", "t1"));
    assert_ne!(here, at("https://docs.example:8443/guide?x=2", "t1"));
    assert_ne!(here, at("https://docs.example:8443/guide?x=1", "other"));
    assert_eq!(here, at("https://docs.example:8443/guide?x=1", "t1"));
    // ace is told the tab and the whole address; a site grant still names only the host.
    let Ok(place) = here else {
        panic!("placed");
    };
    assert_eq!(
        place.expect(),
        Some(json!({"tabId": "t1", "url": "https://docs.example:8443/guide?x=1"}))
    );
    assert_eq!(
        place.grant(),
        Some(crate::grant::Scope::DriveSite {
            host: "docs.example".into()
        })
    );
    // An address being opened has no tab yet, so ace isn't told one.
    let opening = site("https://docs.example/");
    assert_eq!(opening.place.ok().and_then(|place| place.expect()), None);
}

#[test]
fn only_loopback_addresses_and_local_names_are_the_persons_own_machine() {
    for url in [
        "https://127.example.com/settings",
        "https://127.0.0.1.example.com/checkout",
        "https://localhost.example.com/login",
    ] {
        assert!(site(url).sensitive.is_some(), "{url}");
    }
    for url in [
        "http://127.0.0.1:5173/checkout",
        "http://127.8.9.10/login",
        "http://[::1]:3000/settings",
        "http://localhost:3000/login",
        "http://app.localhost/account",
        "http://printer.local/settings",
        "http://shop.test/cart",
    ] {
        assert_eq!(site(url).sensitive, None, "{url}");
    }
}

#[test]
fn a_page_a_device_opens_is_never_a_site_a_grant_names_either_way() {
    let opened = read(
        "sim_act",
        &json!({"simId": "s1", "action": "open_url", "url": "https://github.com/acme"}),
        None,
    );
    let Ok(on_device) = opened.place else {
        panic!("open_url is placed");
    };
    assert!(matches!(on_device, Place::DeviceSite { .. }));
    // It makes no site grant.
    assert_eq!(on_device.grant(), None);
    // And a site grant for the same host doesn't cover it, though it covers the browser's page.
    let github = [grant(crate::grant::Scope::DriveSite {
        host: "github.com".into(),
    })];
    assert!(!on_device.granted_by(&github));
    let Ok(in_browser) = site("https://github.com/acme").place else {
        panic!("placed");
    };
    assert!(in_browser.granted_by(&github));
    // Its page is still read for where it is.
    let paying = read(
        "sim_act",
        &json!({"simId": "s1", "action": "open_url", "url": "https://paypal.com/"}),
        None,
    );
    assert!(paying.sensitive.is_some());
}

#[test]
fn only_input_into_a_tab_or_an_app_or_a_change_to_a_tab_needs_ace_to_hold_it_there() {
    let Ok(tab) = in_tab(json!({}), &tabs(&[("t1", "https://docs.rs/", true, false)])).place else {
        panic!("placed");
    };
    for (tool, arguments) in [
        ("browser_act", json!({"action": "press", "key": "Enter"})),
        ("browser_act", json!({"action": "dialog", "dialogId": "d1"})),
        (
            "browser_evaluate",
            json!({"expression": "1", "mode": "read-only"}),
        ),
        ("browser_history", json!({"direction": "back"})),
        ("browser_measure", json!({})),
        ("browser_tabs", json!({"action": "close", "tabId": "t1"})),
        ("browser_tabs", json!({"action": "keep", "tabId": "t1"})),
        ("browser_tabs", json!({"action": "select", "tabId": "t1"})),
    ] {
        assert!(needs_binding(tool, &arguments, &tab), "{tool} {arguments}");
    }
    // Listing tabs, reading the history or setting up the tab sends no input to the page.
    for (tool, arguments) in [
        ("browser_tabs", json!({"action": "list"})),
        ("browser_tabs", json!({})),
        ("browser_open", json!({})),
        ("browser_history", json!({})),
        ("browser_settings", json!({"action": "resize"})),
    ] {
        assert!(!needs_binding(tool, &arguments, &tab), "{tool} {arguments}");
    }
    let app = Place::App {
        id: "com.apple.TextEdit".into(),
        name: "TextEdit".into(),
    };
    let none = json!({});
    assert!(needs_binding("screen_act", &none, &app) && needs_binding("screen_state", &none, &app));
    // An address being opened has no tab to hold it to.
    let Ok(opening) = site("https://docs.rs/").place else {
        panic!("placed");
    };
    assert!(!needs_binding(
        "browser_act",
        &json!({"action": "click"}),
        &opening
    ));
}

#[test]
fn a_search_key_holding_a_route_is_read_as_one_and_plain_search_text_is_not() {
    for url in [
        "https://example.com/?q=/settings",
        "https://example.com/?q=%2Faccount%2Fsecurity",
        "https://example.com/?s=checkout",
        "https://example.com/?query=sign-in",
        "https://example.com/?search=%23/billing",
        "https://example.com/?next=/settings/keys",
        "https://example.com/?return_to=%2Fadmin",
    ] {
        assert!(site(url).sensitive.is_some(), "{url}");
    }
    for url in [
        "https://example.com/?q=cheap+flights",
        "https://example.com/?q=cheap%20flights%20to%20lisbon",
        "https://www.google.com/search?q=checkout+bags",
        "https://example.com/?s=how+to+pay+less+tax",
    ] {
        assert_eq!(site(url).sensitive, None, "{url}");
    }
}

#[test]
fn a_step_only_the_reviewer_let_run_runs_only_where_ace_holds_it() {
    let Ok(tab) = in_tab(json!({}), &tabs(&[("t1", "https://docs.rs/", true, false)])).place else {
        panic!("placed");
    };
    let held = json!({"tabId": "t1", "url": "https://docs.rs/"});
    // ace takes `expect`: the step carries it, over anything the model put there.
    let sent = bind(
        "browser_act",
        json!({"action": "press", "key": "Enter", "expect": {"tabId": "t9", "url": "x"}}),
        &tab,
        true,
        true,
    );
    assert_eq!(sent.map(|args| args["expect"].clone()), Ok(held));
    // An ace that can't hold it, or arguments it can't be added to: not run on the review alone.
    let press = json!({"action": "press", "key": "Enter"});
    assert_eq!(
        bind("browser_act", press.clone(), &tab, false, true),
        Err(CANT_HOLD)
    );
    assert_eq!(
        bind("browser_act", json!("Enter"), &tab, true, true),
        Err(CANT_HOLD)
    );
    // The person allowed it: it runs as they allowed it.
    assert_eq!(
        bind("browser_act", press.clone(), &tab, false, false),
        Ok(press.clone())
    );
    // A step that sends the page no input needs no holding.
    let list = json!({"action": "list"});
    assert_eq!(
        bind("browser_tabs", list.clone(), &tab, false, true),
        Ok(list)
    );
}

#[test]
fn closing_a_tab_is_placed_by_the_tab_it_closes_never_by_an_address_it_ignores() {
    let answer = tabs(&[
        ("t1", "https://docs.rs/serde", true, false),
        ("t2", "https://mail.google.com/mail/u/0", false, false),
    ]);
    for action in ["close", "keep"] {
        let arguments = json!({"action": action, "tabId": "t2", "url": "https://docs.rs/"});
        let step = read("browser_tabs", &arguments, Some(&answer));
        assert_eq!(tab_of(&step), Some("t2"), "{action}");
        assert!(step.sensitive.is_some(), "{action} acts on the mail tab");
        // Bound to that tab, as ace lists it.
        let Ok(place) = step.place else {
            panic!("placed");
        };
        assert_eq!(
            place.expect(),
            Some(json!({"tabId": "t2", "url": "https://mail.google.com/mail/u/0"}))
        );
        // Without the tab it names, there is no place.
        let unnamed = json!({"action": action, "url": "https://docs.rs/"});
        assert_eq!(
            read("browser_tabs", &unnamed, Some(&answer)).place,
            Err(NO_TAB)
        );
    }
    // Listing ignores a tab it is given; selecting with an address goes there.
    let listed = read(
        "browser_tabs",
        &json!({"action": "list", "tabId": "t2"}),
        Some(&answer),
    );
    assert_eq!(tab_of(&listed), Some("t1"));
    let select = json!({"action": "select", "tabId": "t1", "url": "https://paypal.com/"});
    assert!(
        read("browser_tabs", &select, Some(&answer))
            .sensitive
            .is_some()
    );
}

#[test]
fn closing_the_whole_browser_has_no_place_a_review_could_cover() {
    let step = read(
        "browser_settings",
        &json!({"action": "close", "tabId": "t1"}),
        None,
    );
    assert_eq!(step.place, Err(table::CLOSES_BROWSER));
}

#[test]
fn an_operation_the_table_doesnt_know_has_no_place() {
    let answer = tabs(&[("t1", "https://docs.rs/", true, false)]);
    for (tool, arguments) in [
        ("browser_act", json!({"action": "teleport", "tabId": "t1"})),
        ("browser_act", json!({"tabId": "t1"})),
        ("browser_act", json!({"action": 3})),
        ("browser_settings", json!({})),
        ("browser_new_thing", json!({"tabId": "t1"})),
        ("screen_input", json!({"sessionId": "s1"})),
        ("sim_act", json!({"simId": "s1", "action": "shake"})),
    ] {
        let step = read(tool, &arguments, Some(&answer));
        assert!(step.place.is_err(), "{tool} {arguments}");
    }
}

#[test]
fn every_row_of_the_table_is_one_of_aces_driving_tools_and_appears_once() {
    let mut seen = std::collections::HashSet::new();
    for row in table::TABLE {
        assert!(drives(row.tool), "{}", row.tool);
        assert!(
            seen.insert((row.tool, row.op)),
            "{} {:?} twice",
            row.tool,
            row.op
        );
    }
    // Every operation browser_act takes in ace (mcp-schemas.ts `actKinds`) has its row.
    for action in [
        "click",
        "type",
        "fill_form",
        "press",
        "hover",
        "select",
        "check",
        "uncheck",
        "drag",
        "focus",
        "upload",
        "scroll",
        "dialog",
    ] {
        let arguments = json!({ "action": action });
        assert!(
            table::operation("browser_act", &arguments).is_some(),
            "{action}"
        );
    }
}

#[test]
fn an_operation_ace_runs_for_the_whole_session_has_no_tab_to_place_it_in() {
    let answer = tabs(&[("t1", "https://docs.rs/", true, false)]);
    for (action, why) in [
        ("record_stop", table::STOPS_RECORDING),
        ("extensions", table::WHOLE_BROWSER),
        ("close", table::CLOSES_BROWSER),
    ] {
        // Naming an ordinary tab doesn't place it there: ace ignores the tab.
        let arguments = json!({"action": action, "tabId": "t1"});
        let step = read("browser_settings", &arguments, Some(&answer));
        assert_eq!(step.place, Err(why), "{action}");
    }
    // Asking the person for help names its tab, which ace requires.
    let help = json!({"reason": "sign_in", "message": "Sign in"});
    assert_eq!(
        read("browser_request_help", &help, Some(&answer)).place,
        Err(NO_TAB)
    );
}

#[test]
fn an_unrestricted_script_is_always_the_persons_and_only_a_side_effect_free_one_may_be_reviewed() {
    let answer = tabs(&[("t1", "https://docs.rs/", true, false)]);
    for arguments in [
        json!({"expression": "location.href = '/settings'"}),
        json!({"expression": "1", "mode": "unrestricted"}),
    ] {
        let step = read("browser_evaluate", &arguments, Some(&answer));
        assert_eq!(step.place, Err(table::RUNS_SCRIPT), "{arguments}");
    }
    let read_only = json!({"expression": "document.title", "mode": "read-only"});
    let step = read("browser_evaluate", &read_only, Some(&answer));
    assert_eq!(tab_of(&step), Some("t1"));
    let Ok(place) = step.place else {
        panic!("placed");
    };
    assert!(needs_binding("browser_evaluate", &read_only, &place));
}
