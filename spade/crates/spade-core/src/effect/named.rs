//! What a connected app's tool does, read from its own name when nothing trusted says (ADR 0202,
//! amendment 2). Most apps' MCP servers annotate nothing, so without this every tool of theirs
//! would be undeclared. The reading is conservative: a tool reads only when its name is led by a
//! read verb and nothing in its name or description says it changes anything. It never decides a
//! write, a send or a payment runs: it only recognises reads, which then run, and the effects that
//! always go to the person, which then go to them. Everything else stays undeclared, for the
//! reviewer. An annotation may narrow what it reads (an app that says a tool may write or delete
//! is believed); it never widens it (no server's `readOnlyHint` makes `delete_page` a read).
//!
//! Pure: names and descriptions are untrusted text and are only ever matched against fixed words.

/// What a tool's name says it does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Named {
    /// Only reads: led by a read verb, with no word for a change in its name or description.
    Read,
    /// Spends or moves money.
    Pay,
    /// Sends something in the person's name.
    Send,
    /// Shares, invites, or changes sign-ins, keys, roles or who has access.
    Access,
    /// Deletes, empties or overwrites something.
    Destroys,
    /// Anything else: a write, or a name Spade can't read. The reviewer judges it.
    Unclear,
}

/// Words that lead a read.
const READS: &[&str] = &[
    "list", "get", "search", "fetch", "query", "read", "retrieve", "describe", "find", "lookup",
    "look", "show", "view", "count", "inspect", "browse", "preview", "peek", "whoami",
];

/// Money moving.
const PAYS: &[&str] = &[
    "pay",
    "payout",
    "charge",
    "refund",
    "transfer",
    "purchase",
    "buy",
    "checkout",
    "withdraw",
    "wire",
    "remit",
    "donate",
    "tip",
    "send_money",
];

/// Access changing, whatever the verb.
const ACCESS: &[&str] = &[
    "share",
    "unshare",
    "invite",
    "grant",
    "revoke",
    "rotate",
    "impersonate",
    "authorize",
    "deauthorize",
];

/// What access is made of: changing one is an access change, and reading a secret hands it back.
const ACCESS_NOUNS: &[&str] = &[
    "permission",
    "permissions",
    "role",
    "roles",
    "member",
    "members",
    "membership",
    "collaborator",
    "collaborators",
    "access",
    "acl",
    "owner",
    "ownership",
    "sharing",
];

/// Secrets: any tool that names one goes to the person.
const SECRETS: &[&str] = &[
    "password",
    "passwords",
    "secret",
    "secrets",
    "token",
    "tokens",
    "credential",
    "credentials",
    "apikey",
    "apikeys",
    "passcode",
    "otp",
];

/// Sends in the person's name, whatever follows.
const SENDS: &[&str] = &[
    "send",
    "reply",
    "forward",
    "tweet",
    "retweet",
    "dm",
    "broadcast",
    "notify",
    "email",
    "mail",
    "sms",
    "respond",
];

/// What a send is made of: writing one sends it.
const MESSAGES: &[&str] = &[
    "message",
    "messages",
    "comment",
    "comments",
    "email",
    "emails",
    "mail",
    "reply",
    "replies",
    "tweet",
    "tweets",
    "dm",
    "chat",
    "invitation",
    "invitations",
    "review",
];

/// Deleting, emptying, overwriting.
const DESTROYS: &[&str] = &[
    "delete",
    "del",
    "remove",
    "rm",
    "destroy",
    "drop",
    "purge",
    "erase",
    "wipe",
    "trash",
    "truncate",
    "overwrite",
    "clear",
    "reset",
    "empty",
    "unlink",
    "discard",
];

/// Any change, or two steps in one: none of these is ever in a read's name.
const CHANGES: &[&str] = &[
    "create",
    "add",
    "insert",
    "append",
    "update",
    "upsert",
    "set",
    "put",
    "patch",
    "post",
    "edit",
    "modify",
    "change",
    "write",
    "save",
    "upload",
    "import",
    "sync",
    "move",
    "rename",
    "copy",
    "duplicate",
    "clone",
    "merge",
    "run",
    "execute",
    "exec",
    "invoke",
    "trigger",
    "start",
    "stop",
    "restart",
    "cancel",
    "approve",
    "reject",
    "submit",
    "publish",
    "deploy",
    "close",
    "reopen",
    "assign",
    "unassign",
    "mark",
    "toggle",
    "enable",
    "disable",
    "reserve",
    "restore",
    "apply",
    "accept",
    "decline",
    "follow",
    "unfollow",
    "react",
    "vote",
    "subscribe",
    "unsubscribe",
    "register",
    "login",
    "logout",
    "connect",
    "disconnect",
    "generate",
    "convert",
    "transform",
    "resolve",
    "complete",
    "archive",
    "unarchive",
    "replace",
    "refresh",
    "attach",
    "detach",
    "do",
    "make",
    "perform",
    "and",
    "or",
    "then",
    "plus",
];

/// Words in a description that say a tool changes something: any one keeps it from reading.
const DESCRIBED_CHANGES: &[&str] = &[
    "create",
    "creates",
    "update",
    "updates",
    "delete",
    "deletes",
    "remove",
    "removes",
    "send",
    "sends",
    "modify",
    "modifies",
    "write",
    "writes",
    "overwrite",
    "overwrites",
    "insert",
    "inserts",
    "append",
    "appends",
    "archive",
    "archives",
    "publish",
    "publishes",
    "execute",
    "executes",
    "trash",
    "trashes",
    "move",
    "moves",
    "rename",
    "renames",
    "upload",
    "uploads",
    "share",
    "shares",
    "invite",
    "invites",
    "pay",
    "pays",
    "charge",
    "charges",
    "transfer",
    "transfers",
    "edit",
    "edits",
    "post",
    "replace",
    "replaces",
];

/// A name or text in lower-case words: split at anything not a letter or digit, and where a
/// lower-case letter or digit meets an upper-case one (`listSharedPages`). `api_key` and
/// `send_money` are joined back so they read as one word.
fn words(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut word = String::new();
    let mut last_lower = false;
    for c in text.chars() {
        if !c.is_alphanumeric() {
            if !word.is_empty() {
                out.push(std::mem::take(&mut word));
            }
            last_lower = false;
            continue;
        }
        if c.is_uppercase() && last_lower && !word.is_empty() {
            out.push(std::mem::take(&mut word));
        }
        last_lower = c.is_lowercase() || c.is_ascii_digit();
        word.extend(c.to_lowercase());
    }
    if !word.is_empty() {
        out.push(word);
    }
    let mut joined = Vec::with_capacity(out.len());
    let mut at = 0;
    while at < out.len() {
        let pair = out.get(at + 1).map(|next| format!("{}{next}", out[at]));
        match pair.as_deref() {
            Some("apikey" | "apikeys") => {
                joined.push(pair.unwrap_or_default());
                at += 2;
            }
            Some(_) if out[at] == "send" && out[at + 1] == "money" => {
                joined.push("send_money".to_owned());
                at += 2;
            }
            _ => {
                joined.push(out[at].clone());
                at += 1;
            }
        }
    }
    joined
}

fn any(words: &[String], set: &[&str]) -> bool {
    words.iter().any(|word| set.contains(&word.as_str()))
}

/// What `name` (the server's own tool name) and `description` say the tool does. The
/// description can only keep a name from reading; it never makes one read, pay or send.
pub fn named(name: &str, description: &str) -> Named {
    let name = words(name);
    let changes = any(&name, CHANGES);
    if any(&name, PAYS) {
        return Named::Pay;
    }
    if any(&name, ACCESS) || any(&name, SECRETS) || (changes && any(&name, ACCESS_NOUNS)) {
        return Named::Access;
    }
    if any(&name, SENDS) && !reads_only(&name) {
        return Named::Send;
    }
    if (changes || any(&name, DESTROYS)) && any(&name, MESSAGES) {
        return Named::Send;
    }
    if any(&name, DESTROYS) {
        return Named::Destroys;
    }
    if reads_only(&name) && !any(&words(description), DESCRIBED_CHANGES) {
        return Named::Read;
    }
    Named::Unclear
}

/// A name with a read verb and no word for any change: `list_shared_pages`, `notion-search`,
/// `get_email` (an email read, not sent).
fn reads_only(name: &[String]) -> bool {
    any(name, READS)
        && !any(name, CHANGES)
        && !any(name, DESTROYS)
        && !any(name, PAYS)
        && !any(name, ACCESS)
        && !name.iter().any(|word| {
            // A send verb read as a noun only after a read verb: `search_email`, `get_mail`.
            SENDS.contains(&word.as_str()) && !MESSAGES.contains(&word.as_str())
        })
}

#[cfg(test)]
#[path = "named_tests.rs"]
mod tests;
