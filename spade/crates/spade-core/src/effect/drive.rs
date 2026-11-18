//! Where a driving step acts, and whether that place is the person's alone (ADR 0171,
//! amendment 3). A `browser_*`, `screen_*` or `sim_*` call ace doesn't mark read-only goes to the
//! reviewer; it goes to the person when it acts in mail, messages or chat, a bank, a payment or
//! checkout page, a password manager, the system's settings, a sign-in or account page, or a
//! place Spade can't name. The place comes from the call's arguments (`app`, `url`) or, for a
//! step in a page already open, from what ace reported last in the session. Pure.

use serde_json::Value;

use crate::event::{Event, Known};
use crate::tools::{CALL_TOOL, unwrap_call_tool};

/// What a driving step acts in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// An app, as the call names it, and what ace resolved that name to earlier in the session.
    App {
        given: String,
        resolved: Option<Resolved>,
    },
    /// A page, by its address.
    Site { host: String, path: String },
    /// Spade can't tell.
    Unknown,
}

/// An app as ace reported it: `TextEdit (com.apple.TextEdit)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub name: String,
    pub id: String,
}

impl Target {
    /// How the request names it: the app's name, or the site's host.
    pub fn shown(&self) -> Option<&str> {
        match self {
            Self::App {
                resolved: Some(resolved),
                ..
            } if !resolved.name.is_empty() => Some(&resolved.name),
            Self::App { given, .. } => Some(given),
            Self::Site { host, .. } => Some(host),
            Self::Unknown => None,
        }
    }

    /// The names a drive grant may match it by: the app as named and as ace resolved it, or
    /// the site's host.
    pub fn names(&self) -> Vec<&str> {
        match self {
            Self::App { given, resolved } => {
                let mut names = vec![given.as_str()];
                if let Some(resolved) = resolved {
                    names.extend([resolved.name.as_str(), resolved.id.as_str()]);
                }
                names.retain(|name| !name.trim().is_empty());
                names
            }
            Self::Site { host, .. } => vec![host],
            Self::Unknown => Vec::new(),
        }
    }

    /// What a drive grant for it stores: the app's id as ace reported it, else the app as the
    /// call names it; or the host.
    pub fn key(&self) -> Option<&str> {
        match self {
            Self::App {
                resolved: Some(resolved),
                ..
            } => Some(&resolved.id),
            Self::App { given, .. } => Some(given.trim()),
            Self::Site { host, .. } => Some(host),
            Self::Unknown => None,
        }
    }
}

/// Whether a tool is one of ace's driving families.
pub fn drives(name: &str) -> bool {
    ["browser_", "screen_", "sim_"]
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

/// Where the step `tool` with `arguments` acts: its `app` or `url`, else (a step in a page
/// already open) the page ace last reported for that tab in `events`.
pub fn target(tool: &str, arguments: &Value, events: &[Event]) -> Target {
    let text = |key: &str| arguments.get(key).and_then(Value::as_str);
    if let Some(url) = text("url") {
        return site(url).unwrap_or(Target::Unknown);
    }
    if tool.starts_with("screen_") {
        return match text("app") {
            Some(app) if !app.trim().is_empty() => Target::App {
                given: app.trim().to_owned(),
                resolved: resolved(app, events),
            },
            _ => Target::Unknown,
        };
    }
    if tool.starts_with("sim_") {
        // A simulator runs test builds, not the person's accounts: the app it opens, else the
        // simulator itself.
        let app = text("appId").filter(|app| !app.trim().is_empty());
        return Target::App {
            given: app.unwrap_or("Simulator").trim().to_owned(),
            resolved: None,
        };
    }
    if tool.starts_with("browser_") {
        let tab = arguments.get("tabId").map(scalar);
        return last_page(events, tab.as_deref())
            .and_then(|url| site(&url))
            .unwrap_or(Target::Unknown);
    }
    Target::Unknown
}

/// A string or number as text: a tab id is either.
fn scalar(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// A page's host and path, when `url` is a web address.
pub fn site(url: &str) -> Option<Target> {
    let url = url.trim();
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = match host.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(v6),
        None => host.split(':').next().unwrap_or(host),
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_owned();
    if host.is_empty() {
        return None;
    }
    let path = rest[end..]
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    Some(Target::Site { host, path })
}

/// The browser tools whose answers ace words itself, page address first. Never `browser_evaluate`
/// (its answer is whatever the page's script returns) or a history or log.
const REPORTS_PAGE: &[&str] = &[
    "browser_open",
    "browser_act",
    "browser_tabs",
    "browser_snapshot",
    "browser_find",
];

/// The `screen_*` tools whose answers start with the app ace opened.
const REPORTS_APP: &[&str] = &["screen_state", "screen_act"];

/// The page ace last reported for `tab` (or for any tab, when the call names none): a browser
/// tool's `"url"` (with its `"tabId"`), or a snapshot's `Page: <url> [tab=<id>]` line.
fn last_page(events: &[Event], tab: Option<&str>) -> Option<String> {
    events.iter().rev().find_map(|event| match event {
        Event::Known(Known::ToolFinished {
            name,
            content,
            is_error: false,
            ..
        }) if REPORTS_PAGE.contains(&name.as_str()) => reported_page(content, tab),
        _ => None,
    })
}

fn reported_page(content: &str, tab: Option<&str>) -> Option<String> {
    let matches = |reported: Option<String>| match (tab, reported) {
        (None, _) => true,
        (Some(wanted), Some(reported)) => wanted == reported,
        (Some(_), None) => false,
    };
    if let Ok(value) = serde_json::from_str::<Value>(content)
        && let Some(url) = value.get("url").and_then(Value::as_str)
    {
        return matches(value.get("tabId").map(scalar)).then(|| url.to_owned());
    }
    let line = content.lines().next()?.strip_prefix("Page: ")?;
    let (url, reported) = match line.split_once(" [tab=") {
        Some((url, rest)) => (url, Some(rest.trim_end_matches(']').to_owned())),
        None => (line, None),
    };
    matches(reported).then(|| url.trim().to_owned())
}

/// What ace resolved the app name `given` to, from the latest `screen_*` result for a call that
/// named it: its first line reads `Name (id), frontmost`.
fn resolved(given: &str, events: &[Event]) -> Option<Resolved> {
    let given = given.trim();
    events.iter().rev().find_map(|event| {
        let Event::Known(Known::ToolFinished {
            call_id,
            name,
            content,
            is_error: false,
            ..
        }) = event
        else {
            return None;
        };
        if !REPORTS_APP.contains(&name.as_str()) {
            return None;
        }
        let named = called_app(events, call_id)?;
        if !named.trim().eq_ignore_ascii_case(given) {
            return None;
        }
        header(content.lines().next()?)
    })
}

/// The `app` a stored call named, unwrapping `call_tool`.
fn called_app(events: &[Event], call_id: &str) -> Option<String> {
    events.iter().rev().find_map(|event| match event {
        Event::Known(Known::StepFinished { calls, .. }) => {
            let call = calls.iter().find(|call| call.id == call_id)?;
            let arguments = if call.name == CALL_TOOL {
                unwrap_call_tool(&call.arguments)?.1
            } else {
                call.arguments.clone()
            };
            arguments.get("app")?.as_str().map(str::to_owned)
        }
        _ => None,
    })
}

/// `Name (id), …` read into its name and id.
fn header(line: &str) -> Option<Resolved> {
    let end = match line.find("), ") {
        Some(at) => at + 1,
        None if line.ends_with(')') => line.len(),
        None => return None,
    };
    let head = &line[..end];
    let open = head.rfind(" (")?;
    let id = head[open + 2..head.len() - 1].trim();
    let name = head[..open].trim();
    (!id.is_empty()).then(|| Resolved {
        name: name.to_owned(),
        id: id.to_owned(),
    })
}

/// Why the step's place is the person's alone, as the request words it ("mail, where it can
/// send in your name"); `None` for an app or site the reviewer may decide on.
pub fn sensitive(target: &Target) -> Option<&'static str> {
    match target {
        Target::App { given, resolved } => {
            let mut found = app_words(given);
            if let Some(resolved) = resolved {
                found = found
                    .or_else(|| app_words(&resolved.name))
                    .or_else(|| app_words(&resolved.id));
            } else {
                // ace finds an app by part of its name, so a fragment of a sensitive one is
                // read as that app until ace reports which it opened.
                found = found.or_else(|| fragment(given));
            }
            found
        }
        Target::Site { host, path } => site_words(host, path),
        Target::Unknown => None,
    }
}

/// Whether a drive grant for `place` (an app or a host) may be made: never for a sensitive one.
pub fn grantable(place: &str) -> Result<(), &'static str> {
    let place = place.trim();
    let app = Target::App {
        given: place.to_owned(),
        resolved: None,
    };
    let as_site = site(&format!("https://{place}")).and_then(|site| sensitive(&site));
    match sensitive(&app).or(as_site) {
        Some(why) => Err(why),
        None => Ok(()),
    }
}

const MAIL: &str = "mail or messages, where it can send in your name";
const MONEY: &str = "a bank, payment or checkout, where it can spend money";
const PASSWORDS: &str = "a password manager, where it can read or change sign-ins";
const SETTINGS: &str = "the system's settings, where it can change privacy, security or access";
const SIGN_IN: &str = "a sign-in or account page, where it can enter or change sign-ins";
const SOCIAL: &str = "a social site, where it can post in your name";
const BROWSER: &str = "a web browser, where Spade can't see which site it acts in";

/// Words in an app's name or id that make it sensitive, each with why.
const APP_WORDS: &[(&str, &str)] = &[
    ("mail", MAIL),
    ("outlook", MAIL),
    ("thunderbird", MAIL),
    ("evolution", MAIL),
    ("geary", MAIL),
    ("kmail", MAIL),
    ("olk", MAIL),
    ("spark", MAIL),
    ("message", MAIL),
    ("mobilesms", MAIL),
    ("ichat", MAIL),
    ("facetime", MAIL),
    ("chat", MAIL),
    ("slack", MAIL),
    ("discord", MAIL),
    ("telegram", MAIL),
    ("whatsapp", MAIL),
    ("signal", MAIL),
    ("teams", MAIL),
    ("skype", MAIL),
    ("element", MAIL),
    ("wechat", MAIL),
    ("zoom", MAIL),
    ("bank", MONEY),
    ("wallet", MONEY),
    ("paypal", MONEY),
    ("venmo", MONEY),
    ("cash app", MONEY),
    ("coinbase", MONEY),
    ("stripe", MONEY),
    ("crypto", MONEY),
    ("password", PASSWORDS),
    ("keychain", PASSWORDS),
    ("1password", PASSWORDS),
    ("bitwarden", PASSWORDS),
    ("keepass", PASSWORDS),
    ("lastpass", PASSWORDS),
    ("dashlane", PASSWORDS),
    ("seahorse", PASSWORDS),
    ("authenticator", PASSWORDS),
    ("settings", SETTINGS),
    ("preferences", SETTINGS),
    ("systempreferences", SETTINGS),
    ("control-center", SETTINGS),
    ("control panel", SETTINGS),
    ("ms-settings", SETTINGS),
    ("safari", BROWSER),
    ("chrome", BROWSER),
    ("chromium", BROWSER),
    ("firefox", BROWSER),
    ("edge", BROWSER),
    ("brave", BROWSER),
    ("opera", BROWSER),
    ("vivaldi", BROWSER),
    ("arc", BROWSER),
    ("browser", BROWSER),
];

fn app_words(name: &str) -> Option<&'static str> {
    let name = name.trim().to_ascii_lowercase();
    let parts: Vec<&str> = name
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '-')
        .filter(|part| !part.is_empty())
        .collect();
    APP_WORDS.iter().find_map(|(word, why)| {
        // A short word counts only as a whole part (`arc`, not `archive`); a longer one where a
        // part starts with it (`mailspring`) or anywhere in the name (`1password`).
        let hit = match word.len() {
            0..=3 => parts.contains(word),
            4 => parts.iter().any(|part| part.starts_with(word)),
            _ => name.contains(word),
        };
        hit.then_some(*why)
    })
}

/// Sensitive apps by full name: a name ace would match by part (`ail` finds Mail).
const APP_NAMES: &[(&str, &str)] = &[
    ("mail", MAIL),
    ("messages", MAIL),
    ("facetime", MAIL),
    ("microsoft outlook", MAIL),
    ("microsoft teams", MAIL),
    ("thunderbird", MAIL),
    ("keychain access", PASSWORDS),
    ("passwords", PASSWORDS),
    ("wallet", MONEY),
    ("system settings", SETTINGS),
    ("system preferences", SETTINGS),
    ("safari", BROWSER),
    ("google chrome", BROWSER),
    ("firefox", BROWSER),
];

fn fragment(given: &str) -> Option<&'static str> {
    let given = given.trim().to_ascii_lowercase();
    APP_NAMES
        .iter()
        .find_map(|(name, why)| name.contains(given.as_str()).then_some(*why))
}

/// Hosts that are sensitive whatever the page, by the host or a parent domain.
const HOSTS: &[(&str, &str)] = &[
    ("mail.google.com", MAIL),
    ("gmail.com", MAIL),
    ("outlook.live.com", MAIL),
    ("outlook.office.com", MAIL),
    ("outlook.office365.com", MAIL),
    ("mail.yahoo.com", MAIL),
    ("proton.me", MAIL),
    ("protonmail.com", MAIL),
    ("fastmail.com", MAIL),
    ("icloud.com", MAIL),
    ("hey.com", MAIL),
    ("web.whatsapp.com", MAIL),
    ("whatsapp.com", MAIL),
    ("web.telegram.org", MAIL),
    ("discord.com", MAIL),
    ("slack.com", MAIL),
    ("app.slack.com", MAIL),
    ("messenger.com", MAIL),
    ("teams.microsoft.com", MAIL),
    ("teams.live.com", MAIL),
    ("chat.google.com", MAIL),
    ("messages.google.com", MAIL),
    ("app.element.io", MAIL),
    ("x.com", SOCIAL),
    ("twitter.com", SOCIAL),
    ("facebook.com", SOCIAL),
    ("instagram.com", SOCIAL),
    ("linkedin.com", SOCIAL),
    ("threads.net", SOCIAL),
    ("bsky.app", SOCIAL),
    ("reddit.com", SOCIAL),
    ("paypal.com", MONEY),
    ("venmo.com", MONEY),
    ("cash.app", MONEY),
    ("wise.com", MONEY),
    ("revolut.com", MONEY),
    ("stripe.com", MONEY),
    ("dashboard.stripe.com", MONEY),
    ("pay.google.com", MONEY),
    ("coinbase.com", MONEY),
    ("binance.com", MONEY),
    ("kraken.com", MONEY),
    ("robinhood.com", MONEY),
    ("chase.com", MONEY),
    ("wellsfargo.com", MONEY),
    ("citi.com", MONEY),
    ("capitalone.com", MONEY),
    ("americanexpress.com", MONEY),
    ("schwab.com", MONEY),
    ("fidelity.com", MONEY),
    ("vanguard.com", MONEY),
    ("1password.com", PASSWORDS),
    ("bitwarden.com", PASSWORDS),
    ("lastpass.com", PASSWORDS),
    ("dashlane.com", PASSWORDS),
    ("passwords.google.com", PASSWORDS),
    ("accounts.google.com", SIGN_IN),
    ("myaccount.google.com", SIGN_IN),
    ("login.microsoftonline.com", SIGN_IN),
    ("login.live.com", SIGN_IN),
    ("account.microsoft.com", SIGN_IN),
    ("appleid.apple.com", SIGN_IN),
    ("account.apple.com", SIGN_IN),
    ("id.atlassian.com", SIGN_IN),
    ("signin.aws.amazon.com", SIGN_IN),
    ("console.aws.amazon.com", SIGN_IN),
    ("console.cloud.google.com", SIGN_IN),
    ("portal.azure.com", SIGN_IN),
];

/// Parts of a host that make it sensitive (`mybank.example`, `pay.example`, `login.example`).
const HOST_PARTS: &[(&str, &str)] = &[
    ("bank", MONEY),
    ("wallet", MONEY),
    ("checkout", MONEY),
    ("billing", MONEY),
    ("pay", MONEY),
    ("mail", MAIL),
    ("webmail", MAIL),
    ("login", SIGN_IN),
    ("signin", SIGN_IN),
    ("auth", SIGN_IN),
    ("sso", SIGN_IN),
    ("accounts", SIGN_IN),
    ("account", SIGN_IN),
    ("password", PASSWORDS),
    ("vault", PASSWORDS),
];

/// Path parts that make a page sensitive on any public site (`/checkout`, `/settings/keys`).
const PATH_PARTS: &[(&str, &str)] = &[
    ("checkout", MONEY),
    ("cart", MONEY),
    ("basket", MONEY),
    ("payment", MONEY),
    ("payments", MONEY),
    ("billing", MONEY),
    ("pay", MONEY),
    ("purchase", MONEY),
    ("buy", MONEY),
    ("donate", MONEY),
    ("subscribe", MONEY),
    ("wallet", MONEY),
    ("login", SIGN_IN),
    ("signin", SIGN_IN),
    ("sign-in", SIGN_IN),
    ("sign_in", SIGN_IN),
    ("logon", SIGN_IN),
    ("signup", SIGN_IN),
    ("sign-up", SIGN_IN),
    ("register", SIGN_IN),
    ("auth", SIGN_IN),
    ("oauth", SIGN_IN),
    ("authorize", SIGN_IN),
    ("sso", SIGN_IN),
    ("account", SIGN_IN),
    ("accounts", SIGN_IN),
    ("password", SIGN_IN),
    ("security", SIGN_IN),
    ("2fa", SIGN_IN),
    ("mfa", SIGN_IN),
    ("settings", SIGN_IN),
    ("admin", SIGN_IN),
    ("tokens", SIGN_IN),
    ("keys", SIGN_IN),
    ("access", SIGN_IN),
    ("members", SIGN_IN),
    ("collaborators", SIGN_IN),
    ("invite", SIGN_IN),
    ("inbox", MAIL),
    ("compose", MAIL),
    ("messages", MAIL),
];

fn site_words(host: &str, path: &str) -> Option<&'static str> {
    let listed = HOSTS.iter().find_map(|(listed, why)| {
        let under = host == *listed
            || host
                .strip_suffix(listed)
                .is_some_and(|sub| sub.ends_with('.'));
        under.then_some(*why)
    });
    if listed.is_some() {
        return listed;
    }
    // The person's own dev server (`localhost:3000/login`) is no one's account.
    if loopback(host) {
        return None;
    }
    let labels: Vec<&str> = host.split(['.', '-']).collect();
    let by_host = HOST_PARTS.iter().find_map(|(part, why)| {
        labels
            .iter()
            .any(|label| label.starts_with(part) || label.ends_with(part))
            .then_some(*why)
    });
    by_host.or_else(|| {
        let parts: Vec<&str> = path.split(['/', '.']).filter(|p| !p.is_empty()).collect();
        PATH_PARTS
            .iter()
            .find_map(|(word, why)| parts.contains(word).then_some(*why))
    })
}

fn loopback(host: &str) -> bool {
    host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".test")
        || host == "::1"
        || host.starts_with("127.")
        || host == "0.0.0.0"
}

#[cfg(test)]
mod tests;
