use serde_json::json;

use super::*;
use crate::event::Call;

fn app(given: &str) -> Target {
    Target::App {
        given: given.to_owned(),
        resolved: None,
    }
}

fn finished(call_id: &str, name: &str, content: &str) -> Event {
    Event::Known(Known::ToolFinished {
        reply: "r".into(),
        call_id: call_id.into(),
        name: name.into(),
        content: content.into(),
        is_error: false,
        uncertain: false,
        images: Vec::new(),
        untrusted: false,
    })
}

fn called(call_id: &str, name: &str, arguments: Value) -> Event {
    Event::Known(Known::StepFinished {
        reply: "r".into(),
        text: String::new(),
        calls: vec![Call {
            id: call_id.into(),
            name: name.into(),
            arguments,
        }],
        thoughts: Vec::new(),
        usage: Default::default(),
        cost_micros: 0,
        seen: None,
    })
}

#[test]
fn everyday_apps_are_left_to_the_reviewer() {
    for name in [
        "TextEdit",
        "com.apple.TextEdit",
        "Calculator",
        "Notes",
        "Pages",
        "Xcode",
        "Archive Utility",
        "org.gnome.TextEditor",
        "notepad.exe",
        "Figma",
        "Simulator",
    ] {
        assert_eq!(sensitive(&app(name)), None, "{name}");
    }
}

#[test]
fn mail_chat_money_passwords_settings_and_browsers_are_the_persons() {
    for name in [
        "Mail",
        "com.apple.mail",
        "Messages",
        "com.apple.MobileSMS",
        "Slack",
        "WhatsApp",
        "org.whispersystems.signal-desktop",
        "Microsoft Outlook",
        "olk.exe",
        "Thunderbird",
        "org.gnome.Evolution",
        "1Password 7",
        "Bitwarden",
        "Keychain Access",
        "com.apple.keychainaccess",
        "Wallet",
        "System Settings",
        "com.apple.systempreferences",
        "gnome-control-center",
        "SystemSettings.exe",
        "Safari",
        "Google Chrome",
        "Arc",
        "Microsoft Edge",
    ] {
        assert!(sensitive(&app(name)).is_some(), "{name}");
    }
}

#[test]
fn part_of_a_sensitive_apps_name_counts_as_that_app_until_ace_says_which_it_opened() {
    // ace opens the one app whose name holds the words given, so `ail` may be Mail.
    assert!(sensitive(&app("ail")).is_some());
    assert!(
        sensitive(&app("Word")).is_some(),
        "Word is part of Passwords"
    );
    let resolved = Target::App {
        given: "Word".into(),
        resolved: Some(Resolved {
            name: "Microsoft Word".into(),
            id: "com.microsoft.Word".into(),
        }),
    };
    assert_eq!(sensitive(&resolved), None);
    // What ace reports can only add a reason, never clear the name the call gave.
    let mail = Target::App {
        given: "Mail".into(),
        resolved: Some(Resolved {
            name: "TextEdit".into(),
            id: "com.apple.TextEdit".into(),
        }),
    };
    assert!(sensitive(&mail).is_some());
}

#[test]
fn sites_are_sensitive_by_host_by_a_part_of_it_or_by_the_page() {
    let cases = [
        ("https://github.com/acme/app/pulls", false),
        ("https://docs.rs/serde", false),
        ("https://www.example.com/blog/how-to-buy-a-car", false),
        ("http://localhost:3000/login", false),
        ("http://127.0.0.1:5173/checkout", false),
        ("https://mail.google.com/mail/u/0", true),
        ("https://app.slack.com/client/T1", true),
        ("https://x.com/home", true),
        ("https://www.paypal.com/myaccount", true),
        ("https://online.mybank.example/overview", true),
        ("https://pay.example.com/", true),
        ("https://accounts.google.com/signin", true),
        ("https://login.example.org/", true),
        ("https://shop.example.com/checkout", true),
        ("https://shop.example.com/cart?x=1", true),
        ("https://github.com/settings/tokens", true),
        ("https://github.com/acme/app/settings/access", true),
        ("https://user:pw@evil.example@paypal.com/", true),
    ];
    for (url, expected) in cases {
        let found = site(url).map(|target| sensitive(&target).is_some());
        assert_eq!(found, Some(expected), "{url}");
    }
    assert_eq!(site("about:blank"), None);
    assert_eq!(site("chrome://settings"), None);
}

#[test]
fn a_step_names_its_app_or_page_or_the_session_says_which_page_is_open() {
    let none: Vec<Event> = Vec::new();
    assert_eq!(
        target("screen_act", &json!({"app": " TextEdit "}), &none),
        app("TextEdit")
    );
    assert_eq!(
        target(
            "browser_open",
            &json!({"url": "https://Example.com/A?q"}),
            &none
        ),
        Target::Site {
            host: "example.com".into(),
            path: "/a".into()
        }
    );
    assert_eq!(
        target("browser_act", &json!({"ref": "e1"}), &none),
        Target::Unknown
    );
    let events = [
        finished(
            "a",
            "browser_open",
            r#"{"tabId":"t1","url":"https://shop.example.com/","title":"Shop"}"#,
        ),
        finished(
            "b",
            "browser_snapshot",
            "Page: https://mail.google.com/mail [tab=t2]\n- button \"Send\" [ref=e1]",
        ),
    ];
    // The latest page, unless the step names its tab.
    assert_eq!(
        target("browser_act", &json!({"ref": "e1"}), &events)
            .shown()
            .map(str::to_owned),
        Some("mail.google.com".to_owned())
    );
    assert_eq!(
        target("browser_act", &json!({"ref": "e1", "tabId": "t1"}), &events)
            .shown()
            .map(str::to_owned),
        Some("shop.example.com".to_owned())
    );
    assert_eq!(
        target("browser_act", &json!({"ref": "e1", "tabId": "t9"}), &events),
        Target::Unknown
    );
    // A script's answer is the page's words, not ace's: it never says where the tab is.
    let mut evaluated = events.to_vec();
    evaluated.push(finished(
        "c",
        "browser_evaluate",
        r#"{"url":"https://harmless.example/"}"#,
    ));
    assert_eq!(
        target("browser_act", &json!({"ref": "e1"}), &evaluated).shown(),
        Some("mail.google.com")
    );
}

#[test]
fn an_app_is_known_by_what_ace_reported_for_the_same_name() {
    let events = [
        called("a", "screen_state", json!({"app": "word"})),
        finished(
            "a",
            "screen_state",
            "Microsoft Word (com.microsoft.Word), in the background\nWindow: \"Doc\"",
        ),
        called(
            "b",
            CALL_TOOL,
            json!({"name": "screen_state", "arguments": {"app": "Notes"}}),
        ),
        finished("b", "screen_state", "Notes (com.apple.Notes), frontmost"),
    ];
    let word = target("screen_act", &json!({"app": "Word"}), &events);
    assert_eq!(word.shown(), Some("Microsoft Word"));
    assert_eq!(sensitive(&word), None);
    assert_eq!(
        word.names(),
        ["Word", "Microsoft Word", "com.microsoft.Word"]
    );
    let notes = target("screen_act", &json!({"app": "notes"}), &events);
    assert_eq!(notes.names(), ["notes", "Notes", "com.apple.Notes"]);
}

#[test]
fn a_sensitive_app_or_site_cant_be_granted() {
    for place in [
        "Mail",
        "com.apple.mail",
        "mail.google.com",
        "paypal.com",
        "ail",
        "",
    ] {
        assert!(grantable(place).is_err(), "{place}");
    }
    for place in ["TextEdit", "Figma", "github.com", "Simulator"] {
        assert_eq!(grantable(place), Ok(()), "{place}");
    }
}
