//! The apps bots never use (ADR 0171, amendment 7): the person's own list under Computer use,
//! the one safety net left once Computer use is on. It starts with password managers and money
//! apps, and the person adds or removes entries. Pure.

/// The list a machine starts with.
pub const DEFAULT: &[&str] = &[
    "1Password",
    "Bitwarden",
    "Dashlane",
    "KeePassXC",
    "LastPass",
    "Passwords",
    "Keychain Access",
    "Authenticator",
    "Bank",
    "Wallet",
    "PayPal",
    "Venmo",
    "Cash App",
    "Coinbase",
];

/// The default list, owned.
pub fn default_list() -> Vec<String> {
    DEFAULT.iter().map(|entry| (*entry).to_owned()).collect()
}

/// The longest entry Spade keeps.
pub const MAX_ENTRY: usize = 80;
/// The most entries Spade keeps.
pub const MAX_ENTRIES: usize = 200;

/// The list as the person gave it, kept as Spade stores it: entries trimmed, empty ones and
/// repeats (without regard to case) dropped. `Err` with why for an entry that is too long or
/// holds a control character, or a list too long.
pub fn clean(given: &[String]) -> Result<Vec<String>, &'static str> {
    let mut kept: Vec<String> = Vec::new();
    for entry in given {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        if entry.chars().count() > MAX_ENTRY || entry.chars().any(char::is_control) {
            return Err("An app's name is at most 80 characters, on one line.");
        }
        if !kept.iter().any(|seen| seen.eq_ignore_ascii_case(entry)) {
            kept.push(entry.to_owned());
        }
    }
    if kept.len() > MAX_ENTRIES {
        return Err("The list holds at most 200 apps.");
    }
    Ok(kept)
}

/// The entries of `list` that `next` drops: what turning the list into `next` lets bots use.
pub fn dropped<'a>(list: &'a [String], next: &[String]) -> Vec<&'a str> {
    list.iter()
        .filter(|entry| !next.iter().any(|kept| kept.eq_ignore_ascii_case(entry)))
        .map(String::as_str)
        .collect()
}

/// The entry of `list` that one of `names` (every name and id a step may act in: the name the
/// call gave and each app ace could open for it) falls under, if one does. An entry counts
/// wherever it is part of a name or id (`Bank` in `Bank of America`), and a name the bot gives
/// counts when it is part of an entry (ace opens an app by part of its name, so `pass` may be
/// `1Password`).
pub fn listed<'a>(list: &'a [String], names: &[String]) -> Option<&'a str> {
    list.iter()
        .find(|entry| {
            let entry = entry.trim().to_lowercase();
            !entry.is_empty()
                && names.iter().any(|name| {
                    let name = name.trim().to_lowercase();
                    !name.is_empty() && (name.contains(&entry) || entry.contains(&name))
                })
        })
        .map(String::as_str)
}

/// What the bot is told when a step would act in an app on the list.
pub fn refusal(entry: &str) -> String {
    format!(
        "Not run: {entry} is on the person's list of apps bots never use, under Computer use in \
         Settings › Spade."
    )
}
