//! The places a driving step is the person's alone, and why (ADR 0171, amendment 3). Apps are
//! one table: each entry's word finds the app in a name or id, and its full names catch a part
//! of one (`cord` is Discord, `ail` is Mail), since ace opens the one app whose name holds the
//! words given. Sites are hosts and their parent domains, parts of a host, and parts of a path
//! or of a `#/route`. Pure.

pub(super) const MAIL: &str = "mail or messages, where it can send in your name";
pub(super) const MONEY: &str = "a bank, payment or checkout, where it can spend money";
pub(super) const PASSWORDS: &str = "a password manager, where it can read or change sign-ins";
pub(super) const SETTINGS: &str =
    "the system's settings, where it can change privacy, security or access";
pub(super) const SIGN_IN: &str = "a sign-in or account page, where it can enter or change sign-ins";
pub(super) const SOCIAL: &str = "a social site, where it can post in your name";
pub(super) const BROWSER: &str = "a web browser, where Spade can't see which site it acts in";

/// A sensitive app: the word that finds it in a name or id, its full names, and why.
pub struct App {
    pub word: &'static str,
    pub names: &'static [&'static str],
    pub why: &'static str,
}

const fn app(word: &'static str, names: &'static [&'static str], why: &'static str) -> App {
    App { word, names, why }
}

pub const APPS: &[App] = &[
    app("mail", &["Mail", "Mailspring", "Mimestream"], MAIL),
    app("outlook", &["Microsoft Outlook", "Outlook"], MAIL),
    app("olk", &["olk.exe"], MAIL),
    app("thunderbird", &["Thunderbird"], MAIL),
    app("evolution", &["Evolution"], MAIL),
    app("geary", &["Geary"], MAIL),
    app("kmail", &["KMail"], MAIL),
    app("spark", &["Spark", "Spark Desktop"], MAIL),
    app("message", &["Messages", "Messenger"], MAIL),
    app("mobilesms", &["com.apple.MobileSMS"], MAIL),
    app("mobilemail", &["com.apple.mobilemail"], MAIL),
    app("messaging", &["com.google.android.apps.messaging"], MAIL),
    app("gm", &["com.google.android.gm"], MAIL),
    app("ichat", &["com.apple.iChat"], MAIL),
    app("facetime", &["FaceTime"], MAIL),
    app("chat", &["Chat", "Google Chat", "ChatGPT"], MAIL),
    app("slack", &["Slack"], MAIL),
    app("discord", &["Discord"], MAIL),
    app("telegram", &["Telegram", "Telegram Desktop"], MAIL),
    app("whatsapp", &["WhatsApp"], MAIL),
    app("signal", &["Signal"], MAIL),
    app("teams", &["Microsoft Teams", "Teams"], MAIL),
    app("skype", &["Skype"], MAIL),
    app("element", &["Element"], MAIL),
    app("wechat", &["WeChat"], MAIL),
    app("zoom", &["zoom.us", "Zoom"], MAIL),
    app("bank", &["Banktivity", "Bank of America"], MONEY),
    app("wallet", &["Wallet"], MONEY),
    app("passbook", &["com.apple.Passbook"], MONEY),
    app("paypal", &["PayPal"], MONEY),
    app("venmo", &["Venmo"], MONEY),
    app("cash app", &["Cash App"], MONEY),
    app("coinbase", &["Coinbase"], MONEY),
    app("stripe", &["Stripe"], MONEY),
    app("crypto", &["Crypto.com"], MONEY),
    app(
        "password",
        &["Passwords", "1Password", "1Password 7"],
        PASSWORDS,
    ),
    app("keychain", &["Keychain Access"], PASSWORDS),
    app("bitwarden", &["Bitwarden"], PASSWORDS),
    app("keepass", &["KeePassXC"], PASSWORDS),
    app("lastpass", &["LastPass"], PASSWORDS),
    app("dashlane", &["Dashlane"], PASSWORDS),
    app("seahorse", &["Seahorse"], PASSWORDS),
    app(
        "authenticator",
        &["Authenticator", "Google Authenticator"],
        PASSWORDS,
    ),
    app("settings", &["System Settings", "Settings"], SETTINGS),
    app("preferences", &["System Preferences"], SETTINGS),
    app("control-center", &["gnome-control-center"], SETTINGS),
    app("control panel", &["Control Panel"], SETTINGS),
    app("safari", &["Safari"], BROWSER),
    app("chrome", &["Google Chrome", "Chrome"], BROWSER),
    app("chromium", &["Chromium"], BROWSER),
    app("firefox", &["Firefox"], BROWSER),
    app("edge", &["Microsoft Edge"], BROWSER),
    app("brave", &["Brave Browser"], BROWSER),
    app("opera", &["Opera"], BROWSER),
    app("vivaldi", &["Vivaldi"], BROWSER),
    app("arc", &["Arc"], BROWSER),
    app("browser", &["Tor Browser"], BROWSER),
];

/// Why an app, by a name or id, is the person's: a word of the table in it.
pub fn app_by_name(name: &str) -> Option<&'static str> {
    let name = name.trim().to_lowercase();
    let parts: Vec<&str> = name
        .split(|c: char| !c.is_alphanumeric() && c != '-')
        .filter(|part| !part.is_empty())
        .collect();
    APPS.iter().find_map(|entry| {
        let word = entry.word;
        // A short word counts only as a whole part (`arc`, not `archive`); a longer one where a
        // part starts with it (`mailspring`) or anywhere in the name (`1password`).
        let hit = match word.len() {
            0..=3 => parts.contains(&word),
            4 => parts.iter().any(|part| part.starts_with(word)),
            _ => name.contains(word),
        };
        hit.then_some(entry.why)
    })
}

/// Why `given` may be a sensitive app ace would open for it: it names one, or it is part of a
/// sensitive app's name or word.
pub fn app_given(given: &str) -> Option<&'static str> {
    let wanted = given.trim().to_lowercase();
    app_by_name(&wanted).or_else(|| {
        APPS.iter().find_map(|entry| {
            let part_of = |name: &str| name.to_lowercase().contains(&wanted);
            (part_of(entry.word) || entry.names.iter().any(|name| part_of(name)))
                .then_some(entry.why)
        })
    })
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
    ("whatsapp.com", MAIL),
    ("web.telegram.org", MAIL),
    ("discord.com", MAIL),
    ("slack.com", MAIL),
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
    ("login", SIGN_IN),
    ("signin", SIGN_IN),
    ("auth", SIGN_IN),
    ("sso", SIGN_IN),
    ("account", SIGN_IN),
    ("password", PASSWORDS),
    ("vault", PASSWORDS),
];

/// Parts of a path or a `#/route` that make a page sensitive on any public site.
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

/// Why a page (its canonical host, decoded path and fragment) is the person's.
pub fn site(host: &str, path: &str, fragment: &str) -> Option<&'static str> {
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
        // A single-page app's route (`#/settings`) is a path too.
        let parts: Vec<&str> = [path, fragment]
            .iter()
            .flat_map(|text| text.split(['/', '.', '?', '&', '=', '!']))
            .filter(|part| !part.is_empty())
            .collect();
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
        || host == "[::1]"
        || host.starts_with("127.")
}
