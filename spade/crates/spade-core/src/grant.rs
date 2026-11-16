//! Scoped capability grants (ADR 0167 decision 5): what a bot may do outside its sandbox without
//! a review, each bounded by what it reaches ("push only to `spade/*`", "write only in this
//! folder"). A worker's grants never exceed its parent's (ADR 0161): its effective grants are its
//! own, kept only where one of its parent's effective grants covers them. Pure.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What a grant allows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Scope {
    /// Pushes to branches matching `branch` of repos matching `repo` (`owner/name`).
    GitPush { repo: String, branch: String },
    /// Comments on pull requests of repos matching `repo`; with `own_only`, only on ones the
    /// bot opened.
    PrComment {
        repo: String,
        #[serde(default)]
        own_only: bool,
    },
    /// A consented project folder, read-only or read-write in the bot's sandbox.
    Folder {
        path: String,
        #[serde(default)]
        write: bool,
    },
    /// One tool, with each named argument matching its pattern.
    Tool {
        tool: String,
        #[serde(default)]
        arguments: BTreeMap<String, String>,
    },
}

/// A grant as stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grant {
    pub id: String,
    #[serde(flatten)]
    pub scope: Scope,
    /// `person`, or the id of the parent bot that passed it down.
    pub by: String,
    pub created_at: i64,
}

/// Who made a grant.
pub const BY_PERSON: &str = "person";

/// Something a bot is about to do, as grants are checked against it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action<'a> {
    GitPush { repo: &'a str, branch: &'a str },
    PrComment { repo: &'a str, own: bool },
    Folder { path: &'a str, write: bool },
    Tool { tool: &'a str, arguments: &'a Value },
}

/// Whether `scope` allows `action`.
pub fn covers(scope: &Scope, action: &Action<'_>) -> bool {
    match (scope, action) {
        (Scope::GitPush { repo, branch }, Action::GitPush { repo: r, branch: b }) => {
            glob(repo, r) && glob(branch, b)
        }
        (Scope::PrComment { repo, own_only }, Action::PrComment { repo: r, own }) => {
            glob(repo, r) && (!own_only || *own)
        }
        (Scope::Folder { path, write }, Action::Folder { path: p, write: w }) => {
            inside(p, path) && (*write || !w)
        }
        (
            Scope::Tool { tool, arguments },
            Action::Tool {
                tool: name,
                arguments: given,
            },
        ) => {
            tool == name
                && arguments.iter().all(|(key, pattern)| {
                    given
                        .get(key)
                        .and_then(Value::as_str)
                        .is_some_and(|value| glob(pattern, value))
                })
        }
        _ => false,
    }
}

/// Whether any of `grants` allows `action`.
pub fn allowed(grants: &[Grant], action: &Action<'_>) -> bool {
    grants.iter().any(|grant| covers(&grant.scope, action))
}

/// Whether everything `child` allows, `parent` allows too. Conservative: a pair it can't prove
/// is refused, never let through.
pub fn within(child: &Scope, parent: &Scope) -> bool {
    match (child, parent) {
        (
            Scope::GitPush { repo, branch },
            Scope::GitPush {
                repo: pr,
                branch: pb,
            },
        ) => narrower(repo, pr) && narrower(branch, pb),
        (
            Scope::PrComment { repo, own_only },
            Scope::PrComment {
                repo: pr,
                own_only: po,
            },
        ) => narrower(repo, pr) && (*own_only || !po),
        (
            Scope::Folder { path, write },
            Scope::Folder {
                path: pp,
                write: pw,
            },
        ) => inside(path, pp) && (*pw || !write),
        (
            Scope::Tool { tool, arguments },
            Scope::Tool {
                tool: pt,
                arguments: pa,
            },
        ) => {
            tool == pt
                && pa.iter().all(|(key, pattern)| {
                    arguments
                        .get(key)
                        .is_some_and(|mine| narrower(mine, pattern))
                })
        }
        _ => false,
    }
}

/// A bot's effective grants: its own for a top-level bot (`parent` is `None`), else those of its
/// own that a grant of its parent's effective ones covers.
pub fn effective(own: &[Grant], parent: Option<&[Grant]>) -> Vec<Grant> {
    match parent {
        None => own.to_vec(),
        Some(parent) => own
            .iter()
            .filter(|grant| parent.iter().any(|p| within(&grant.scope, &p.scope)))
            .cloned()
            .collect(),
    }
}

/// Checks a scope the person or a parent is about to grant: refused with why. `never` says
/// whether a tool may never be granted (a payment, sending as the person, changing sign-ins or
/// access: those always go to the person).
pub fn check(scope: &Scope, never: &dyn Fn(&str) -> Option<&'static str>) -> Result<(), String> {
    let pattern = |what: &str, text: &str| {
        if text.trim().is_empty() {
            Err(format!("{what} is empty"))
        } else if text.contains(char::is_whitespace) && what != "argument" {
            Err(format!("{what} has spaces"))
        } else {
            Ok(())
        }
    };
    match scope {
        Scope::GitPush { repo, branch } => {
            pattern("repo", repo)?;
            pattern("branch", branch)?;
            // A grant to push to every branch would cover a repo's main branch.
            if matches!(branch.as_str(), "*" | "**") {
                return Err("a push grant names the branches it covers, like spade/*".to_owned());
            }
            Ok(())
        }
        Scope::PrComment { repo, .. } => pattern("repo", repo),
        Scope::Folder { path, .. } => {
            if !path.starts_with('/') && !windows_absolute(path) {
                return Err("a folder is given as an absolute path".to_owned());
            }
            if path == "/" || path.split(['/', '\\']).any(|part| part == "..") {
                return Err("a folder can't be the whole disk or use ..".to_owned());
            }
            Ok(())
        }
        Scope::Tool { tool, arguments } => {
            pattern("tool", tool)?;
            if let Some(why) = never(tool) {
                return Err(format!(
                    "{tool} can't be granted: {why} That always goes to the person."
                ));
            }
            for value in arguments.values() {
                pattern("argument", value)?;
            }
            Ok(())
        }
    }
}

fn windows_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() > 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// Whether `path` is `folder` or inside it, by whole components.
fn inside(path: &str, folder: &str) -> bool {
    let folder = folder.trim_end_matches(['/', '\\']);
    path == folder
        || path
            .strip_prefix(folder)
            .is_some_and(|rest| rest.starts_with(['/', '\\']))
}

/// Matches `text` to `pattern`: `*` matches within a `/`-separated segment, `**` across them.
pub fn glob(pattern: &str, text: &str) -> bool {
    fn go(p: &[u8], t: &[u8]) -> bool {
        match p {
            [] => t.is_empty(),
            [b'*', b'*', rest @ ..] => (0..=t.len()).any(|i| go(rest, &t[i..])),
            [b'*', rest @ ..] => {
                let mut i = 0;
                loop {
                    if go(rest, &t[i..]) {
                        return true;
                    }
                    if i == t.len() || t[i] == b'/' {
                        return false;
                    }
                    i += 1;
                }
            }
            [c, rest @ ..] => t.first() == Some(c) && go(rest, &t[1..]),
        }
    }
    go(pattern.as_bytes(), text.as_bytes())
}

/// Whether every text `child` matches, `parent` matches. Proven in the shapes a grant takes:
/// equal patterns, a literal child, a parent of `**`, or a parent that is a literal prefix
/// followed by one `*` or `**`.
fn narrower(child: &str, parent: &str) -> bool {
    let wild = |s: &str| s.contains('*');
    if child == parent || parent == "**" {
        return true;
    }
    if !wild(child) {
        return glob(parent, child);
    }
    if let Some(prefix) = parent.strip_suffix("**")
        && !wild(prefix)
    {
        return child.starts_with(prefix);
    }
    if let Some(prefix) = parent.strip_suffix('*')
        && !wild(prefix)
    {
        let Some(rest) = child.strip_prefix(prefix) else {
            return false;
        };
        return !rest.contains('/') && !rest.contains("**");
    }
    false
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn grant(scope: Scope) -> Grant {
        Grant {
            id: "g".to_owned(),
            scope,
            by: BY_PERSON.to_owned(),
            created_at: 0,
        }
    }

    fn push(repo: &str, branch: &str) -> Scope {
        Scope::GitPush {
            repo: repo.to_owned(),
            branch: branch.to_owned(),
        }
    }

    #[test]
    fn a_push_grant_covers_only_its_branches_of_its_repos() {
        let scope = push("arpan404/*", "spade/*");
        let can = |repo, branch| covers(&scope, &Action::GitPush { repo, branch });
        assert!(can("arpan404/ace", "spade/fix-login"));
        assert!(!can("arpan404/ace", "main"));
        assert!(!can("arpan404/ace", "spade/a/b"));
        assert!(!can("someone/ace", "spade/x"));
        let deep = push("arpan404/ace", "spade/**");
        assert!(covers(
            &deep,
            &Action::GitPush {
                repo: "arpan404/ace",
                branch: "spade/a/b"
            }
        ));
    }

    #[test]
    fn a_comment_grant_limited_to_its_own_prs_refuses_others() {
        let scope = Scope::PrComment {
            repo: "arpan404/ace".to_owned(),
            own_only: true,
        };
        let on = |own| {
            covers(
                &scope,
                &Action::PrComment {
                    repo: "arpan404/ace",
                    own,
                },
            )
        };
        assert!(on(true));
        assert!(!on(false));
    }

    #[test]
    fn a_folder_grant_covers_its_folder_by_whole_components_and_writes_only_if_granted() {
        let read = Scope::Folder {
            path: "/Users/p/code/app".to_owned(),
            write: false,
        };
        let at = |path, write| covers(&read, &Action::Folder { path, write });
        assert!(at("/Users/p/code/app/src/main.rs", false));
        assert!(!at("/Users/p/code/app/src/main.rs", true));
        assert!(!at("/Users/p/code/app2/x", false));
    }

    #[test]
    fn a_tool_grant_needs_every_named_argument_to_match() {
        let scope = Scope::Tool {
            tool: "shell".to_owned(),
            arguments: BTreeMap::from([("command".to_owned(), "cargo test**".to_owned())]),
        };
        let run = |arguments: Value| {
            covers(
                &scope,
                &Action::Tool {
                    tool: "shell",
                    arguments: &arguments,
                },
            )
        };
        assert!(run(json!({"command": "cargo test -p spade-core"})));
        assert!(!run(json!({"command": "cargo publish"})));
        assert!(!run(json!({})));
        assert!(!covers(
            &scope,
            &Action::Tool {
                tool: "web_fetch",
                arguments: &json!({"command": "cargo test"})
            }
        ));
    }

    #[test]
    fn a_worker_keeps_only_grants_its_parent_covers() {
        let parent = vec![grant(push("arpan404/ace", "spade/*"))];
        let own = vec![
            grant(push("arpan404/ace", "spade/docs-*")),
            grant(push("arpan404/ace", "spade/**")),
            grant(push("arpan404/ace", "main")),
            grant(push("arpan404/*", "spade/x")),
        ];
        let kept = effective(&own, Some(&parent));
        assert_eq!(kept, vec![own[0].clone()]);
        assert_eq!(effective(&own, None), own);
        assert!(effective(&own, Some(&[])).is_empty());
    }

    #[test]
    fn narrowing_never_widens_writes_or_drops_conditions() {
        let read = Scope::Folder {
            path: "/p/app".to_owned(),
            write: false,
        };
        let write_inside = Scope::Folder {
            path: "/p/app/src".to_owned(),
            write: true,
        };
        assert!(!within(&write_inside, &read));
        let own = Scope::PrComment {
            repo: "a/b".to_owned(),
            own_only: true,
        };
        let any = Scope::PrComment {
            repo: "a/b".to_owned(),
            own_only: false,
        };
        assert!(within(&own, &any));
        assert!(!within(&any, &own));
        let tool = |args: &[(&str, &str)]| Scope::Tool {
            tool: "t".to_owned(),
            arguments: args
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
        };
        assert!(within(
            &tool(&[("to", "me"), ("x", "1")]),
            &tool(&[("to", "me")])
        ));
        assert!(!within(&tool(&[]), &tool(&[("to", "me")])));
    }

    #[test]
    fn grants_that_could_reach_everything_or_always_go_to_the_person_are_refused() {
        let never = |tool: &str| (tool == "stripe_pay").then_some("It could spend money.");
        assert!(check(&push("a/b", "*"), &never).is_err());
        assert!(check(&push("a/b", "spade/*"), &never).is_ok());
        for path in ["relative/path", "/", "/p/../etc"] {
            let folder = Scope::Folder {
                path: path.to_owned(),
                write: true,
            };
            assert!(check(&folder, &never).is_err(), "{path}");
        }
        let pay = Scope::Tool {
            tool: "stripe_pay".to_owned(),
            arguments: BTreeMap::new(),
        };
        let refused = check(&pay, &never).err().unwrap_or_default();
        assert!(refused.contains("always goes to the person"), "{refused}");
    }

    #[test]
    fn a_grant_round_trips_with_its_kind_beside_its_fields() {
        let stored = json!({"id": "g1", "kind": "git_push", "repo": "a/b", "branch": "spade/*",
                            "by": "person", "created_at": 5});
        let grant: Grant =
            serde_json::from_value(stored.clone()).unwrap_or_else(|_| grant(push("", "")));
        assert_eq!(grant.scope, push("a/b", "spade/*"));
        assert_eq!(serde_json::to_value(&grant).unwrap_or_default(), stored);
    }
}
