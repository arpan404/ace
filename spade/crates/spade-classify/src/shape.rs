//! What a single value looks like, without what it says: a URL and its host, an e-mail address,
//! a phone number, an amount of money, a path and where it points against the bot's folder.

use crate::hash::Bag;

/// Where a path points, read lexically (nothing on disk is looked at).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Place {
    /// In the bot's folder: relative and never climbing out, or under the workspace path.
    Inside,
    /// `/dev/null` and its kin: nowhere.
    Nowhere,
    /// Under the person's home (`~`).
    Home,
    /// An absolute path outside the workspace.
    Absolute,
    /// Climbs out of the folder with `..`.
    Parent,
    /// Through a variable: can't be said.
    Variable,
}

impl Place {
    pub fn name(self) -> &'static str {
        match self {
            Self::Inside => "inside",
            Self::Nowhere => "nowhere",
            Self::Home => "home",
            Self::Absolute => "absolute",
            Self::Parent => "parent",
            Self::Variable => "variable",
        }
    }

    /// Whether it may be outside the bot's folders.
    pub fn outside(self) -> bool {
        !matches!(self, Self::Inside | Self::Nowhere)
    }
}

/// Whether `word` reads as a path at all.
pub(crate) fn is_path(word: &str) -> bool {
    word.contains('/') || word.starts_with('~') || word.starts_with('.') || word.contains('$')
}

/// Where the path `word` points, with `workspace` the bot's folder when known.
pub(crate) fn place(word: &str, workspace: Option<&str>) -> Place {
    if word.contains('$') || word.contains('`') {
        return Place::Variable;
    }
    if word.starts_with('~') {
        return Place::Home;
    }
    if matches!(
        word,
        "/dev/null" | "/dev/zero" | "/dev/stdout" | "/dev/stderr" | "/dev/stdin"
    ) || word.starts_with("/dev/fd/")
    {
        return Place::Nowhere;
    }
    if word.starts_with('/') {
        let under = workspace
            .map(|w| w.trim_end_matches('/'))
            .filter(|w| !w.is_empty())
            .and_then(|w| word.strip_prefix(w))
            .filter(|rest| rest.is_empty() || rest.starts_with('/'));
        return match under {
            Some(rest) if climbs(rest) => Place::Parent,
            Some(_) => Place::Inside,
            None => Place::Absolute,
        };
    }
    if climbs(word) {
        Place::Parent
    } else {
        Place::Inside
    }
}

/// Whether a relative path climbs above where it starts.
fn climbs(path: &str) -> bool {
    let mut depth: i32 = 0;
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                depth -= 1;
                if depth < 0 {
                    return true;
                }
            }
            _ => depth += 1,
        }
    }
    false
}

/// The host of a URL in `word`, lower-cased, without user, port or path.
pub(crate) fn host(word: &str) -> Option<(String, String)> {
    let (scheme, rest) = word.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = authority
        .split(':')
        .next()
        .unwrap_or("")
        .trim_matches(['[', ']'])
        .to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    Some((scheme.to_ascii_lowercase(), host))
}

/// The last two labels of a host (`api.stripe.com` is `stripe.com`).
pub(crate) fn domain(host: &str) -> &str {
    let mut dots = host.rmatch_indices('.');
    match (dots.next(), dots.next()) {
        (Some(_), Some((at, _))) => &host[at + 1..],
        _ => host,
    }
}

/// Another machine's path, as `scp` and `rsync` write it: `user@host:path` or `host:/path`.
fn remote(word: &str) -> bool {
    let Some((machine, path)) = word.split_once(':') else {
        return false;
    };
    !machine.is_empty()
        && !machine.contains(['/', ' ', '='])
        && machine.contains('.') | machine.contains('@')
        && (machine.contains('@') || path.starts_with('/') || path.starts_with('~'))
}

/// Whether a value of this shape names a place outside the bot's folders by itself: another
/// machine, or a URL that isn't a web page (a bucket, a database, a host).
pub(crate) fn elsewhere(word: &str, shape: &str) -> bool {
    shape == "remote"
        || shape == "url"
            && host(word.trim())
                .is_some_and(|(scheme, _)| !matches!(scheme.as_str(), "http" | "https"))
}

fn email(word: &str) -> bool {
    let Some((user, domain)) = word.split_once('@') else {
        return false;
    };
    !user.is_empty()
        && domain.contains('.')
        && !word.contains(['/', ' ', ':'])
        && !domain.starts_with('.')
}

fn phone(word: &str) -> bool {
    let digits = word.chars().filter(char::is_ascii_digit).count();
    word.starts_with('+')
        && digits >= 7
        && word
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | ' ' | '(' | ')' | '.'))
}

fn money(word: &str) -> bool {
    let trimmed = word.trim();
    let number = trimmed
        .trim_start_matches(['$', '€', '£', '¥'])
        .trim_end_matches(|c: char| c.is_ascii_alphabetic() || c == ' ');
    // A trailing currency code (`100 USD`): the last three characters, taken char-safe.
    let trailing_code = {
        let tail: String = trimmed.chars().rev().take(3).collect();
        tail.chars().count() == 3 && tail.chars().all(|c| c.is_ascii_uppercase())
    };
    let symbol = trimmed.starts_with(['$', '€', '£', '¥']) || trailing_code;
    symbol
        && !number.is_empty()
        && number
            .chars()
            .all(|c| c.is_ascii_digit() || c == '.' || c == ',')
}

/// The shape of a string value, as one word, adding what it carries (a host) under `space`.
pub(crate) fn of(word: &str, workspace: Option<&str>, space: &str, bag: &mut Bag) -> &'static str {
    let word = word.trim();
    if word.is_empty() {
        return "empty";
    }
    if let Some((scheme, host)) = host(word) {
        bag.add("U", &[&scheme]);
        if !matches!(scheme.as_str(), "http" | "https") {
            // A storage bucket, a remote host, a database: not a page to read.
            bag.add("U", &["not_web"]);
        }
        bag.add("H", &[&host]);
        bag.add("HD", &[domain(&host)]);
        bag.add(space, &["host", domain(&host)]);
        return "url";
    }
    if remote(word) {
        return "remote";
    }
    if email(word) {
        return "email";
    }
    if phone(word) {
        return "phone";
    }
    if money(word) {
        return "money";
    }
    if word.parse::<f64>().is_ok() {
        return "number";
    }
    if word.starts_with('@') && word.len() > 1 {
        return "at_file";
    }
    if is_path(word) && !word.contains(' ') {
        let at = place(word, workspace);
        for part in word.split('/') {
            if part.starts_with('.') && part.len() > 1 && part != ".." {
                bag.add("DOT", &[&part.to_ascii_lowercase()]);
            }
        }
        if let Some((_, extension)) = word.rsplit_once('.')
            && (1..=12).contains(&extension.len())
            && !extension.contains('/')
        {
            bag.add("EXT", &[&extension.to_ascii_lowercase()]);
        }
        return match at {
            Place::Inside => "path_inside",
            Place::Nowhere => "path_nowhere",
            Place::Home => "path_home",
            Place::Absolute => "path_absolute",
            Place::Parent => "path_parent",
            Place::Variable => "path_variable",
        };
    }
    if word.contains(char::is_whitespace) {
        return if word.chars().count() > 80 {
            "long_text"
        } else {
            "text"
        };
    }
    if word.chars().any(|c| c.is_ascii_digit()) && word.chars().any(|c| c.is_alphabetic()) {
        return "id";
    }
    "word"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_placed_against_the_bots_folder() {
        let w = Some("/data/workspace/b1");
        for (path, expected) in [
            ("src/main.rs", Place::Inside),
            ("./a/../b", Place::Inside),
            ("../other", Place::Parent),
            ("a/../../x", Place::Parent),
            ("~/.ssh/id_rsa", Place::Home),
            ("/etc/hosts", Place::Absolute),
            ("/data/workspace/b1/out.txt", Place::Inside),
            ("/data/workspace/b1/../b2/x", Place::Parent),
            ("/data/workspace/b10/x", Place::Absolute),
            ("$HOME/x", Place::Variable),
            ("/dev/null", Place::Nowhere),
        ] {
            assert_eq!(place(path, w), expected, "{path}");
        }
    }

    #[test]
    fn values_are_read_for_their_shape() {
        let mut bag = Bag::default();
        for (value, expected) in [
            ("https://api.stripe.com/v1/charges", "url"),
            ("sam@example.com", "email"),
            ("+1 (555) 123-4567", "phone"),
            ("$12.50", "money"),
            ("42", "number"),
            ("@body.json", "at_file"),
            ("hello there", "text"),
            ("cus_123abc", "id"),
            ("deploy@host.example:/tmp/", "remote"),
            ("db.example.com:/backup", "remote"),
        ] {
            assert_eq!(of(value, None, "A", &mut bag), expected, "{value}");
        }
        assert_eq!(domain("api.stripe.com"), "stripe.com");
    }
}
