//! Reading what an AppleScript or JavaScript for Automation script does to the person's messaging
//! apps (ADR 0163, amendment 1): one that sends, replies, forwards or posts from Messages, Mail,
//! Outlook, WhatsApp, Slack and the like sends in their name, so it goes to the person. The rest
//! of what `osascript` and `shortcuts` do drives other apps, which the reviewer judges.

use super::super::Sensitive;
use super::effects::{Effect, Run};
use super::parse::Simple;

/// Apps that send in the person's name, by the names and bundle ids scripts target them with.
const MESSENGERS: &[&str] = &[
    "messages",
    "com.apple.mobilesms",
    "com.apple.ichat",
    "mail",
    "com.apple.mail",
    "outlook",
    "microsoft outlook",
    "com.microsoft.outlook",
    "whatsapp",
    "net.whatsapp.whatsapp",
    "desktop.whatsapp",
    "slack",
    "com.tinyspeck.slackmacgap",
    "telegram",
    "telegram desktop",
    "ru.keepcoder.telegram",
    "org.telegram.desktop",
    "discord",
    "com.hnc.discord",
    "signal",
    "org.whispersystems.signal-desktop",
    "microsoft teams",
    "teams",
    "com.microsoft.teams",
    "com.microsoft.teams2",
    "skype",
    "com.skype.skype",
    "wechat",
    "com.tencent.xinwechat",
    "line",
    "jp.naver.line.mac",
    "messenger",
    "com.facebook.archon",
    "spark",
    "airmail",
    "thunderbird",
    "mimestream",
    "superhuman",
];

/// Words in a script's code (outside its strings) that send from an app: its own commands, and
/// typing or pressing keys into it through System Events.
const SENDING: &[&str] = &[
    "send",
    "reply",
    "forward",
    "redirect",
    "post",
    "keystroke",
    "key",
    "click",
];

/// Words in a shortcut's name that say it sends.
const SHORTCUT_SENDING: &[&str] = &[
    "send", "message", "messages", "text", "sms", "imessage", "email", "mail", "reply", "forward",
    "post", "tweet", "dm", "whatsapp", "slack", "telegram", "discord", "signal",
];

/// What an `osascript` command does: a script that sends from a messaging app is a send as the
/// person; any other drives apps. Its code comes from `-e` lines, a here-document or here-string,
/// or a file (`osascript x.applescript`, `osascript < x`), which is read and shown.
pub(super) fn osascript(simple: &Simple) -> Effect {
    let words = &simple.words;
    let mut lines: Vec<&str> = Vec::new();
    let mut file: Option<&str> = None;
    let mut at = 1;
    while at < words.len() {
        let word = words[at].as_str();
        at += 1;
        match word {
            "-e" => {
                lines.extend(words.get(at).map(String::as_str));
                at += 1;
            }
            // Flags with a value: the language, output style.
            "-l" | "-s" => at += 1,
            "-" => break,
            _ if word.starts_with('-') => {}
            // The script file; what follows are its arguments.
            _ if lines.is_empty() => {
                file = Some(word);
                break;
            }
            _ => break,
        }
    }
    let code = if lines.is_empty() {
        simple.here.clone()
    } else {
        Some(lines.join("\n"))
    };
    let mut effect = Effect::kind(match &code {
        Some(code) if sends(code) => Sensitive::MessageAsPerson,
        _ => Sensitive::Automation,
    });
    if code.is_none() {
        let from = file.or_else(|| simple.reads_from.first().map(String::as_str));
        effect
            .runs
            .extend(from.map(|f| Run::AppleScript(f.to_owned())));
    }
    effect
}

/// What `shortcuts` does: running one whose name says it sends is a send as the person; any
/// other drives apps.
pub(super) fn shortcuts(words: &[String]) -> Effect {
    let mut rest = words.iter().skip(1).filter(|w| !w.starts_with('-'));
    let sending = rest.next().is_some_and(|sub| sub == "run")
        && rest.next().is_some_and(|name| {
            name.to_lowercase()
                .split(|c: char| !c.is_alphanumeric())
                .any(|w| SHORTCUT_SENDING.contains(&w))
        });
    Effect::kind(if sending {
        Sensitive::MessageAsPerson
    } else {
        Sensitive::Automation
    })
}

/// Whether an AppleScript or JavaScript for Automation script names a messaging app and has a
/// word that sends. Strings name the apps (`tell application "Messages"`, `Application('Mail')`);
/// verbs are looked for outside double-quoted strings, so a message's own text doesn't count.
/// An apostrophe isn't a quote in AppleScript, so text in single quotes or backticks is searched
/// for verbs too, which can only send more to the person.
pub(super) fn sends(script: &str) -> bool {
    let (code, doubled) = split(script, &['"']);
    // Each quote read apart, so an apostrophe in a comment can't hide an app's name.
    let targets = ['\'', '`']
        .iter()
        .flat_map(|q| split(script, &[*q]).1)
        .chain(doubled)
        .any(|s| MESSENGERS.contains(&s.trim().to_lowercase().as_str()));
    targets
        && code
            .to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .any(|w| SENDING.contains(&w))
}

/// A script's code with its strings (quoted with any of `quotes`, `\` escaping) taken out, and
/// the strings.
fn split(script: &str, quotes: &[char]) -> (String, Vec<String>) {
    let mut code = String::new();
    let mut strings = Vec::new();
    let mut chars = script.chars();
    while let Some(c) = chars.next() {
        if !quotes.contains(&c) {
            code.push(c);
            continue;
        }
        let mut text = String::new();
        while let Some(ch) = chars.next() {
            match ch {
                '\\' => text.extend(chars.next()),
                _ if ch == c => break,
                _ => text.push(ch),
            }
        }
        // Keeps words on either side apart.
        code.push(' ');
        strings.push(text);
    }
    (code, strings)
}
