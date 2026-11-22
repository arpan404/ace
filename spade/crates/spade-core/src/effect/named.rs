//! What a connected app's tool does, read from its own name when nothing trusted says (ADR 0202,
//! amendment 5). Most apps' MCP servers annotate nothing, so without this every tool of theirs
//! would be undeclared. The reading is conservative. A tool reads only when its name, folded to
//! its compatibility form and split into words (`listSharedPages`, `list2pages`), is led by a
//! read verb and holds no word for a change anywhere, inside a longer word too
//! (`searchandupdate`) and in the other languages listed here; a name with letters outside ASCII
//! never reads. It is an ordinary write only when its one verb is `create`, `update`, `edit`,
//! `append`, `add`, `set` or `insert` and nothing in it reaches past the app's own content.
//! Payments, sends, access changes and deletes are recognised wherever they appear. Everything
//! else stays undeclared, for the reviewer. An annotation may narrow what it reads, never widen
//! it, and what a call's arguments reach is read separately ([`super::shape`]).
//!
//! Pure: names and descriptions are untrusted text and are only ever matched against fixed words.

use unicode_normalization::UnicodeNormalization;

/// What a tool's name says it does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Named {
    /// Only reads: led by a read verb, with no word for a change anywhere in its name (inside a
    /// longer word too) or in its description, and nothing but ASCII letters, digits and
    /// separators.
    Read,
    /// An ordinary change to the app's own content: `create`, `update`, `edit`, `append`, `add`,
    /// `set` or `insert`, with nothing else it could be. The only kind an app's Always allow
    /// covers.
    Write,
    /// Spends or moves money.
    Pay,
    /// Sends something in the person's name.
    Send,
    /// Shares, invites, or changes sign-ins, keys, roles or who has access, or names a secret.
    Access,
    /// Deletes, empties or overwrites something.
    Destroys,
    /// Anything else: a change Spade can't place, or a name it can't read. The reviewer judges it.
    Unclear,
}

/// Words that lead a read.
const READS: &[&str] = &[
    "list", "get", "search", "fetch", "query", "read", "retrieve", "describe", "find", "lookup",
    "look", "show", "view", "count", "inspect", "browse", "preview", "peek", "whoami",
];

/// Ordinary changes to the app's own content.
const WRITES: &[&str] = &["create", "update", "edit", "append", "add", "set", "insert"];

/// Money moving, as a whole word.
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

/// Money moving, anywhere in the name.
const PAY_STEMS: &[&str] = &[
    "transfer", "refund", "payout", "purchase", "checkout", "withdraw", "remit", "donate",
];

/// Access changing, as a whole word.
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

/// Access changing, or a secret, anywhere in the name.
const ACCESS_STEMS: &[&str] = &[
    "share",
    "invite",
    "grant",
    "revoke",
    "permission",
    "password",
    "secret",
    "token",
    "credential",
    "apikey",
    "impersonat",
    "authoriz",
    "collaborator",
    "ownership",
    "passcode",
];

/// What access is made of: changing one is an access change.
const ACCESS_NOUNS: &[&str] = &[
    "role",
    "roles",
    "member",
    "members",
    "membership",
    "access",
    "acl",
    "owner",
    "sharing",
    "otp",
];

/// Sends in the person's name, as a whole word.
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

/// Sends, anywhere in the name.
const SEND_STEMS: &[&str] = &[
    "send",
    "forward",
    "notify",
    "broadcast",
    "tweet",
    "enviar",
    "envoy",
    "inviare",
    "senden",
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

/// Deleting, emptying, overwriting, as a whole word.
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

/// Deleting, anywhere in the name, in the languages Spade lists cheaply.
const DESTROY_STEMS: &[&str] = &[
    "delete",
    "remove",
    "destroy",
    "purge",
    "erase",
    "wipe",
    "trash",
    "truncate",
    "overwrite",
    "unlink",
    "discard",
    "borrar",
    "elimin",
    "supprim",
    "loesch",
    "losch",
    "exclu",
];

/// Any change, or two steps in one, as a whole word: none is ever in a read's or an ordinary
/// write's name.
const CHANGES: &[&str] = &[
    "insert",
    "upsert",
    "put",
    "patch",
    "post",
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
    "y",
    "et",
    "und",
    "ou",
    "oder",
];

/// A change anywhere in the name, inside a longer word too, in the languages Spade lists cheaply.
const CHANGE_STEMS: &[&str] = &[
    "create",
    "update",
    "edit",
    "delete",
    "remove",
    "insert",
    "upsert",
    "append",
    "write",
    "modif",
    "patch",
    "upload",
    "import",
    "publish",
    "deploy",
    "execut",
    "invoke",
    "trigger",
    "submit",
    "archive",
    "rename",
    "move",
    "transfer",
    "purchase",
    "refund",
    "destroy",
    "purge",
    "erase",
    "truncate",
    "overwrite",
    "send",
    "share",
    "invite",
    "revoke",
    "grant",
    "sync",
    "approve",
    "cancel",
    "restore",
    "merge",
    "replace",
    "assign",
    "toggle",
    "enable",
    "disable",
    "crear",
    "borrar",
    "actualiz",
    "modific",
    "elimin",
    "enviar",
    "supprim",
    "envoy",
    "erstell",
    "loesch",
    "aender",
    "aktualis",
    "senden",
    "criar",
    "exclu",
    "atualiz",
    "inviare",
    "aggiorn",
    "cancell",
];

/// What keeps a name from being an ordinary write, anywhere in it: what an Always allow may never
/// cover, and what reaches outside the app's own content.
const NOT_ORDINARY: &[&str] = &[
    "publish",
    "share",
    "send",
    "pay",
    "delete",
    "remove",
    "access",
    "credential",
    "token",
    "secret",
    "password",
    "permission",
    "member",
    "role",
    "invite",
    "webhook",
    "url",
    "email",
    "mail",
    "message",
    "comment",
    "post",
    "deploy",
    "release",
    "merge",
    "execut",
    "script",
    "code",
    "sql",
    "drive",
    "click",
    "sync",
    "import",
    "upload",
    "export",
    "key",
    "owner",
];

/// Words in a description that say a tool does more than change the app's own content: any one
/// keeps a name from being an ordinary write.
const DESCRIBED_SENSITIVE: &[&str] = &[
    "send",
    "sends",
    "sent",
    "email",
    "emails",
    "notify",
    "notifies",
    "publish",
    "publishes",
    "published",
    "share",
    "shares",
    "shared",
    "invite",
    "invites",
    "pay",
    "pays",
    "charge",
    "charges",
    "transfer",
    "transfers",
    "delete",
    "deletes",
    "remove",
    "removes",
    "post",
    "posts",
    "webhook",
    "permission",
    "permissions",
    "access",
    "token",
    "password",
    "secret",
    "deploy",
    "deploys",
    "message",
    "messages",
    "forward",
    "forwards",
];

/// Whole words that only look like a change: an adjective of a read (`list_shared_pages`).
const BENIGN: &[&str] = &[
    "shared",
    "updated",
    "created",
    "modified",
    "archived",
    "published",
    "sender",
    "senders",
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

/// A name or text in lower-case words: split at anything not a letter or digit, where a lower-case
/// letter or digit meets an upper-case one (`listSharedPages`), and between letters and digits.
/// `api_key` and `send_money` are joined back so they read as one word.
pub fn words(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut word = String::new();
    let mut last: Option<char> = None;
    for c in text.chars() {
        if !c.is_alphanumeric() {
            if !word.is_empty() {
                out.push(std::mem::take(&mut word));
            }
            last = None;
            continue;
        }
        let boundary = last.is_some_and(|before| {
            (c.is_uppercase() && (before.is_lowercase() || before.is_numeric()))
                || (c.is_numeric() != before.is_numeric())
        });
        if boundary && !word.is_empty() {
            out.push(std::mem::take(&mut word));
        }
        last = Some(c);
        word.extend(c.to_lowercase());
    }
    if !word.is_empty() {
        out.push(word);
    }
    let mut joined = Vec::with_capacity(out.len());
    let mut at = 0;
    while at < out.len() {
        let pair = out
            .get(at + 1)
            .map(|next| (out[at].as_str(), next.as_str()));
        match pair {
            Some(("api", "key" | "keys")) => {
                joined.push("apikey".to_owned());
                at += 2;
            }
            Some(("send", "money")) => {
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

/// One tool name, read once.
struct Reading {
    words: Vec<String>,
    /// Its words run together, the ones that only look like a change left out: where a change
    /// hidden inside a longer word is found.
    joined: String,
}

impl Reading {
    fn new(name: &str) -> Self {
        // Compatibility forms folded first: a fullwidth `ｓｅｎｄ` is `send`.
        let folded: String = name.nfkc().collect();
        let words = words(&folded);
        let joined = words
            .iter()
            .filter(|word| !BENIGN.contains(&word.as_str()))
            .map(String::as_str)
            .collect();
        Self { words, joined }
    }

    fn has(&self, set: &[&str]) -> bool {
        self.words.iter().any(|word| set.contains(&word.as_str()))
    }

    fn inside(&self, stems: &[&str]) -> bool {
        stems.iter().any(|stem| self.joined.contains(stem))
    }

    /// A read verb and no word for any change, whole or inside a longer word.
    fn reads(&self) -> bool {
        self.has(READS)
            && !self.has(CHANGES)
            && !self.has(WRITES)
            && !self.has(DESTROYS)
            && !self.has(PAYS)
            && !self.has(ACCESS)
            && !self.inside(CHANGE_STEMS)
            // A send verb reads as a noun only after a read verb: `search_email`, `get_mail`.
            && !self
                .words
                .iter()
                .any(|word| SENDS.contains(&word.as_str()) && !MESSAGES.contains(&word.as_str()))
    }

    /// Exactly one ordinary write verb, as a whole word, and nothing else that changes anything:
    /// no read verb, no other change as a word or inside one, nothing an Always allow may not
    /// cover.
    fn writes(&self) -> bool {
        let verbs = self
            .words
            .iter()
            .filter(|word| WRITES.contains(&word.as_str()))
            .count();
        let others: String = self
            .words
            .iter()
            .filter(|word| !WRITES.contains(&word.as_str()) && !BENIGN.contains(&word.as_str()))
            .map(String::as_str)
            .collect();
        verbs == 1
            && !self.has(READS)
            && !self.has(CHANGES)
            && !self.inside(NOT_ORDINARY)
            && !CHANGE_STEMS.iter().any(|stem| others.contains(stem))
    }
}

/// What a description says the tool itself does: its first sentence, the way every app's tool
/// descriptions lead, with code spans and identifiers taken out. What follows is how to use it,
/// and names other tools (`use it with update_data_source`) or says what it never does
/// ("Reading never authorizes a write"): a change word there says nothing about this tool.
fn lead(description: &str) -> String {
    let paragraph = description
        .trim_start()
        .split("\n\n")
        .next()
        .unwrap_or_default();
    let mut sentence = paragraph;
    for (at, c) in paragraph.char_indices() {
        let next = paragraph[at + c.len_utf8()..].chars().next();
        if matches!(c, '.' | '!' | '?' | '\n') && next.is_none_or(char::is_whitespace) {
            sentence = &paragraph[..at];
            break;
        }
    }
    let mut prose = String::with_capacity(sentence.len());
    for (index, span) in sentence.split('`').enumerate() {
        // Odd spans sit between backticks: code, never prose.
        if index % 2 == 1 {
            prose.push(' ');
            continue;
        }
        for token in span.split_whitespace() {
            // An identifier (`update_data_source`, `notion://docs`) names something else.
            if !token.contains(['_', ':', '/', '=', '(', '.']) {
                prose.push_str(token);
            }
            prose.push(' ');
        }
    }
    prose
}

/// What `name` (the server's own tool name) and `description` say the tool does. The
/// description can only keep a name from reading; it never makes one read, pay or send. A name
/// with anything but ASCII letters, digits and separators (a look-alike letter from another
/// script, a fullwidth form) is never a read or an ordinary write, though a payment, a send, an
/// access change or a delete is still recognised in it once folded.
pub fn named(name: &str, description: &str) -> Named {
    let read = Reading::new(name);
    let changes = read.has(CHANGES) || read.has(WRITES);
    if read.has(PAYS) || read.inside(PAY_STEMS) {
        return Named::Pay;
    }
    if read.has(ACCESS) || read.inside(ACCESS_STEMS) || (changes && read.has(ACCESS_NOUNS)) {
        return Named::Access;
    }
    let sends = read.has(SENDS) && !read.reads();
    if sends || read.inside(SEND_STEMS) || ((changes || read.has(DESTROYS)) && read.has(MESSAGES)) {
        return Named::Send;
    }
    if read.has(DESTROYS) || read.inside(DESTROY_STEMS) {
        return Named::Destroys;
    }
    if !name.is_ascii() {
        return Named::Unclear;
    }
    if read.reads() && !Reading::new(&lead(description)).has(DESCRIBED_CHANGES) {
        return Named::Read;
    }
    if read.writes() && !Reading::new(description).has(DESCRIBED_SENSITIVE) {
        return Named::Write;
    }
    Named::Unclear
}

#[cfg(test)]
#[path = "named_tests.rs"]
mod tests;
