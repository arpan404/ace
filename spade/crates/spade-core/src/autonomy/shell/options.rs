//! Reading the options of the programs that talk to the network: values attached to a flag
//! (`-XPOST`, `--data=x`, `-fkey=v`), short flags run together (`-sSd x`, `-Ffile=@a`), and the
//! forms Spade can't be sure of, which go to the person.

use super::super::Sensitive;

pub(super) const METHODS: &[&str] = &["POST", "PUT", "PATCH", "DELETE"];

/// What curl's options say: it sends (data, a form, an upload, a writing method), or reads its
/// options from somewhere Spade doesn't see.
pub(super) fn curl(words: &[String]) -> Option<Sensitive> {
    // Short flags that send, and those that take a value (the rest of the word, or the next).
    const SENDS: &[char] = &['d', 'F', 'T'];
    const VALUED: &str = "AbcCdDeEFHKmoPQrTuUwxXyYzt";
    const LONG_SENDS: &[&str] = &[
        "--data",
        "--data-raw",
        "--data-binary",
        "--data-urlencode",
        "--data-ascii",
        "--form",
        "--form-string",
        "--upload-file",
        "--json",
        "--post301",
        "--post302",
        "--post303",
    ];
    let mut at = 1;
    while at < words.len() {
        let word = &words[at];
        at += 1;
        if word == "--" {
            break;
        }
        if let Some(long) = word.strip_prefix("--") {
            let (name, value) = match long.split_once('=') {
                Some((name, value)) => (format!("--{name}"), Some(value.to_owned())),
                None => (word.clone(), None),
            };
            if LONG_SENDS.contains(&name.as_str()) {
                return Some(Sensitive::Network);
            }
            // Options from a file or another program: Spade can't see what they send.
            if matches!(name.as_str(), "--config" | "--next") {
                return Some(Sensitive::Unclear);
            }
            if name == "--request" {
                let method = value.or_else(|| words.get(at).cloned());
                if method.is_some_and(|m| METHODS.contains(&m.to_uppercase().as_str())) {
                    return Some(Sensitive::Network);
                }
            }
            continue;
        }
        let Some(cluster) = word.strip_prefix('-').filter(|c| !c.is_empty()) else {
            continue;
        };
        for (i, flag) in cluster.char_indices() {
            if !flag.is_ascii_alphanumeric() && flag != '#' && flag != ':' {
                return Some(Sensitive::Unclear);
            }
            if SENDS.contains(&flag) {
                return Some(Sensitive::Network);
            }
            if flag == 'K' {
                return Some(Sensitive::Unclear);
            }
            if VALUED.contains(flag) {
                let attached = &cluster[i + flag.len_utf8()..];
                let value = if attached.is_empty() {
                    at += 1;
                    words.get(at - 1).cloned()
                } else {
                    Some(attached.to_owned())
                };
                if flag == 'X'
                    && value.is_some_and(|m| METHODS.contains(&m.to_uppercase().as_str()))
                {
                    return Some(Sensitive::Network);
                }
                break;
            }
        }
    }
    None
}

/// What wget's options say. It takes any unambiguous start of a long option (`--post-d`), and
/// `-e` runs a settings command, which could send.
pub(super) fn wget(words: &[String]) -> Option<Sensitive> {
    const SENDS: &[&str] = &["post-data", "post-file", "body-data", "body-file"];
    for (at, word) in words.iter().enumerate().skip(1) {
        if let Some(long) = word.strip_prefix("--") {
            let name = long.split_once('=').map_or(long, |(name, _)| name);
            if name.len() >= 3 && SENDS.iter().any(|s| s.starts_with(name)) {
                return Some(Sensitive::Network);
            }
            if name.len() >= 3 && "method".starts_with(name) {
                let value = long
                    .split_once('=')
                    .map(|(_, v)| v.to_owned())
                    .or_else(|| words.get(at + 1).cloned());
                if value.is_some_and(|m| METHODS.contains(&m.to_uppercase().as_str())) {
                    return Some(Sensitive::Network);
                }
            }
            if name.len() >= 3 && ("execute".starts_with(name) || "config".starts_with(name)) {
                return Some(Sensitive::Unclear);
            }
        } else if word.starts_with('-') && word.len() > 1 && word[1..].contains(['e']) {
            return Some(Sensitive::Unclear);
        }
    }
    None
}

/// Whether `gh api`'s options write: fields (`-f`, `-F`, attached or not), an input body, or a
/// writing method.
pub(super) fn gh_api_writes(words: &[String]) -> bool {
    words.iter().enumerate().any(|(at, w)| {
        let short = |flag: &str| w.starts_with(flag) && !w.starts_with("--");
        if short("-f") || short("-F") {
            return true;
        }
        let long = w.split_once('=').map_or(w.as_str(), |(name, _)| name);
        if matches!(long, "--field" | "--raw-field" | "--input") {
            return true;
        }
        let method = if long == "--method" || w == "-X" {
            w.split_once('=')
                .map(|(_, v)| v.to_owned())
                .or_else(|| words.get(at + 1).cloned())
        } else {
            w.strip_prefix("-X")
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
        };
        method.is_some_and(|m| METHODS.contains(&m.to_uppercase().as_str()))
    })
}
