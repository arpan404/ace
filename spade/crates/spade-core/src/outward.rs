//! The arguments of Spade's typed outward tools (ADR 0171 decision 2): pushes, comments and
//! messages that run outside the sandbox with the person's sign-ins. Each value is checked here
//! before any program starts, so nothing a bot writes can reach a program as an option, a
//! transport or a script. Pure.

/// A repository as `owner/name`.
pub fn repo(text: &str) -> Result<(), String> {
    let mut parts = text.split('/');
    let (Some(owner), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(format!("{text} isn't a repository as owner/name"));
    };
    let fine = |part: &str| {
        !part.is_empty()
            && !part.starts_with(['-', '.'])
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    if fine(owner) && fine(name) {
        Ok(())
    } else {
        Err(format!("{text} isn't a repository as owner/name"))
    }
}

/// A branch name git accepts and no program can read as an option.
pub fn branch(text: &str) -> Result<(), String> {
    let bad = text.is_empty()
        || text.starts_with(['-', '/', '.'])
        || text.ends_with(['/', '.'])
        || text.ends_with(".lock")
        || text.contains("..")
        || text.contains("//")
        || text.contains("@{")
        || text == "@"
        || text.split('/').any(|part| part.starts_with('.'))
        || text
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || "~^:?*[\\".contains(c));
    if bad {
        Err(format!("{text} isn't a branch name Spade pushes"))
    } else {
        Ok(())
    }
}

/// A remote's name (`origin`).
pub fn remote(text: &str) -> Result<(), String> {
    let fine = !text.is_empty()
        && !text.starts_with('-')
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if fine {
        Ok(())
    } else {
        Err(format!("{text} isn't a remote's name"))
    }
}

/// Where a remote's URL points: its host and its `owner/name`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Remote {
    pub host: String,
    pub repo: String,
}

/// A remote URL Spade pushes to: `https://host/owner/name(.git)`, `ssh://[user@]host/owner/name`
/// or `user@host:owner/name`. Every other transport (`ext::`, `file://`, a local path, a URL that
/// starts with `-`) is refused, since it could run a program or reach the machine itself.
pub fn remote_url(url: &str) -> Result<Remote, String> {
    let refused = || {
        Err(format!(
            "Spade pushes only to https or ssh remotes, not {url}"
        ))
    };
    let url = url.trim();
    if url.starts_with('-') || url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return refused();
    }
    let (host, path) = if let Some(rest) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("ssh://"))
    {
        let Some((authority, path)) = rest.split_once('/') else {
            return refused();
        };
        let host = authority.rsplit('@').next().unwrap_or(authority);
        (host.split(':').next().unwrap_or(host), path)
    } else if !url.contains("://")
        && let Some((user_host, path)) = url.split_once(':')
        && let Some((_, host)) = user_host.split_once('@')
    {
        (host, path)
    } else {
        return refused();
    };
    let valid_host = !host.is_empty()
        && !host.starts_with('-')
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.'));
    let name = path.trim_matches('/').trim_end_matches(".git");
    if !valid_host || repo(name).is_err() {
        return refused();
    }
    Ok(Remote {
        host: host.to_ascii_lowercase(),
        repo: name.to_owned(),
    })
}

/// Whether a remote is the repository the call names, by `owner/name` (any case).
pub fn same_repo(remote: &Remote, named: &str) -> bool {
    remote.repo.eq_ignore_ascii_case(named)
}

/// A pull request or issue number.
pub fn number(value: &serde_json::Value) -> Result<u64, String> {
    value
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or_else(|| "number is a pull request or issue number, like 42".to_owned())
}

/// The longest comment or message body Spade sends.
pub const LONGEST_BODY: usize = 65_000;

/// A body to send: some text, not too long.
pub fn body(text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        Err("the body is empty".to_owned())
    } else if text.chars().count() > LONGEST_BODY {
        Err(format!("the body is longer than {LONGEST_BODY} characters"))
    } else {
        Ok(())
    }
}

/// Who a message goes to: a phone number, an email address or a Messages handle, never
/// something a program could read as an option.
pub fn recipient(text: &str) -> Result<(), String> {
    let fine = !text.trim().is_empty()
        && !text.starts_with('-')
        && text.chars().count() <= 320
        && !text.chars().any(char::is_control);
    if fine {
        Ok(())
    } else {
        Err(format!("{text} isn't someone to send to"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_https_and_ssh_remotes_of_a_named_repository_are_pushed_to() {
        let remote = |host: &str, repo: &str| {
            Ok(Remote {
                host: host.to_owned(),
                repo: repo.to_owned(),
            })
        };
        let cases = [
            (
                "https://github.com/acme/app.git",
                remote("github.com", "acme/app"),
            ),
            (
                "https://token@github.com/acme/app",
                remote("github.com", "acme/app"),
            ),
            (
                "ssh://git@github.com:22/acme/app.git",
                remote("github.com", "acme/app"),
            ),
            (
                "git@github.com:acme/app.git",
                remote("github.com", "acme/app"),
            ),
        ];
        for (url, expected) in cases {
            assert_eq!(remote_url(url), expected, "{url}");
        }
        for url in [
            "ext::sh -c touch% /tmp/x",
            "file:///Users/me/repo",
            "/Users/me/repo",
            "../repo",
            "-uhttps://github.com/a/b",
            "https://github.com/a/b/c",
            "https://github.com/",
            "git@github.com:-x/app",
            "fd::3",
        ] {
            assert!(remote_url(url).is_err(), "{url}");
        }
        let found = remote_url("https://github.com/Acme/App.git").ok();
        assert!(found.is_some_and(|r| same_repo(&r, "acme/app")));
    }

    #[test]
    fn branches_remotes_and_repositories_never_read_as_options() {
        for good in ["spade/fix-1", "main", "feature/a.b"] {
            assert!(branch(good).is_ok(), "{good}");
        }
        for bad in [
            "-f",
            "--force",
            "a..b",
            "a b",
            "x.lock",
            "a/.hidden",
            "@",
            "a@{1}",
            "a:b",
            "",
        ] {
            assert!(branch(bad).is_err(), "{bad}");
        }
        assert!(remote("origin").is_ok());
        assert!(remote("--upload-pack=x").is_err());
        assert!(repo("acme/app").is_ok());
        for bad in ["acme", "acme/app/x", "-a/b", "a/.b", "a b/c"] {
            assert!(repo(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn bodies_numbers_and_recipients_are_checked_before_anything_is_sent() {
        assert!(body("Looks good").is_ok());
        assert!(body("  ").is_err());
        assert!(body(&"x".repeat(LONGEST_BODY + 1)).is_err());
        assert_eq!(number(&serde_json::json!(42)), Ok(42));
        assert!(number(&serde_json::json!(0)).is_err());
        assert!(number(&serde_json::json!("42")).is_err());
        assert!(recipient("+15551234567").is_ok());
        assert!(recipient("me@example.com").is_ok());
        assert!(recipient("-e").is_err());
        assert!(recipient("a\nb").is_err());
    }
}
