// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used)]
//! Read-only admission and write scopes for the non-GitHub CLIs (`read-only-api.ts`, ADR
//! 0117): one exact request shape per host and an allowlist per adapter. Anything else is
//! refused before spawning, never rewritten.

use regex::Regex;

use crate::transport::command::CommandRequest;

/// The CLIs ace reaches non-GitHub hosts through.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostCli {
    Glab,
    Origin,
    Tea,
    Bkt,
}

impl HostCli {
    /// The command name, as `request.command` spells it.
    pub fn command(self) -> &'static str {
        match self {
            HostCli::Glab => "glab",
            HostCli::Origin => "origin",
            HostCli::Tea => "tea",
            HostCli::Bkt => "bkt",
        }
    }
}

/// One write an adapter admits: an HTTP method and the endpoints it may reach.
#[derive(Debug, Clone)]
pub struct HostApiWrite {
    pub method: String,
    pub endpoint: Regex,
}

/// One adapter's write, pinned under `root`, the exact API path of one repository.
#[derive(Debug, Clone, Copy)]
pub struct ScopedWrite<'a> {
    pub method: &'a str,
    /// A regular-expression source matched after the root, to the endpoint's end.
    pub path: &'a str,
}

/// Builds `root` + `path` endpoints, refusing any other repository.
#[allow(clippy::expect_used)]
pub fn writes_under(root: &str, writes: &[ScopedWrite<'_>]) -> Vec<HostApiWrite> {
    let escaped = escape_regex(root);
    writes
        .iter()
        .map(|write| HostApiWrite {
            method: write.method.to_owned(),
            endpoint: Regex::new(&format!("^{escaped}{}$", write.path))
                .expect("an adapter's write path compiles"),
        })
        .collect()
}

fn escape_regex(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        if matches!(
            character,
            '.' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '^' | '$' | '\\'
        ) {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

/// Output-only glab flags a read may add after its fixed prefix, each at most once.
const GLAB_OPTIONAL: [&str; 2] = ["--include", "--paginate"];

/// Whether `request` is one explicit GET through `cli api`, matched against an exact shape.
pub fn is_read_only_api_request(cli: HostCli, request: &CommandRequest, host: &str) -> bool {
    let args = &request.args;
    if request.command != cli.command() || request.input.is_some() {
        return false;
    }
    let Some(endpoint) = args.get(1) else {
        return false;
    };
    if args.first().is_none_or(|arg| arg != "api")
        || endpoint.is_empty()
        || endpoint.starts_with('-')
    {
        return false;
    }
    match cli {
        HostCli::Bkt => {
            bkt_endpoint(endpoint, true)
                && args.len() == 6
                && args[2] == "--method"
                && args[3] == "GET"
                && args[4] == "--context"
                && args[5] == host
        }
        HostCli::Tea => {
            tea_endpoint(endpoint)
                && args.len() == 7
                && args[2] == "--method"
                && args[3] == "GET"
                && args[4] == "--login"
                && args[5] == host
                && args[6] == "--include"
        }
        HostCli::Origin => args.len() == 4 && args[2] == "--method" && args[3] == "GET",
        HostCli::Glab => {
            if args.len() < 6
                || args[2] != "-X"
                || args[3] != "GET"
                || args[4] != "--hostname"
                || args[5] != host
            {
                return false;
            }
            let rest = &args[6..];
            let unique: std::collections::HashSet<&String> = rest.iter().collect();
            rest.iter().all(|arg| GLAB_OPTIONAL.contains(&arg.as_str()))
                && unique.len() == rest.len()
        }
    }
}

/// Whether `request` is one admitted write, where `<METHOD> <endpoint>` matches a write.
pub fn is_admitted_write_request(
    cli: HostCli,
    request: &CommandRequest,
    host: &str,
    writes: &[HostApiWrite],
) -> bool {
    if request.command != cli.command() {
        return false;
    }
    let args = &request.args;
    match cli {
        HostCli::Bkt => {
            let (Some(endpoint), Some(method)) = (args.get(1), args.get(3)) else {
                return false;
            };
            (args.len() == 6
                || (args.len() == 8
                    && args[6] == "--input"
                    && is_json_object(args.get(7).map(String::as_str).unwrap_or(""))))
                && args[0] == "api"
                && bkt_endpoint(endpoint, false)
                && args[2] == "--method"
                && args[4] == "--context"
                && args[5] == host
                && request.input.is_none()
                && writes
                    .iter()
                    .any(|write| write.method == *method && write.endpoint.is_match(endpoint))
        }
        HostCli::Tea => {
            let (Some(endpoint), Some(method)) = (args.get(1), args.get(3)) else {
                return false;
            };
            args.len() == 9
                && args[0] == "api"
                && tea_endpoint(endpoint)
                && args[2] == "--method"
                && args[4] == "--login"
                && args[5] == host
                && args[6] == "--include"
                && args[7] == "--data"
                && args[8] == "@-"
                && request.input.as_deref().is_some_and(is_json_object)
                && writes
                    .iter()
                    .any(|write| write.method == *method && write.endpoint.is_match(endpoint))
        }
        HostCli::Glab => {
            let (Some(endpoint), Some(method)) = (args.get(1), args.get(3)) else {
                return false;
            };
            args.len() == 9
                && args[0] == "api"
                && !endpoint.starts_with('-')
                && args[2] == "-X"
                && args[4] == "--hostname"
                && args[5] == host
                && args[6] == "--include"
                && args[7] == "--input"
                && args[8] == "-"
                && request.input.as_deref().is_some_and(is_json_object)
                && writes
                    .iter()
                    .any(|write| write.method == *method && write.endpoint.is_match(endpoint))
        }
        // Origin writes aren't admitted yet.
        HostCli::Origin => false,
    }
}

/// Whether a request is any read or admitted write; refusal is the runner's to decide.
pub fn is_admitted_api_request(
    cli: HostCli,
    request: &CommandRequest,
    host: &str,
    writes: &[HostApiWrite],
) -> bool {
    is_read_only_api_request(cli, request, host)
        || is_admitted_write_request(cli, request, host, writes)
}

fn is_json_object(text: &str) -> bool {
    matches!(ace_json::parse(text), Ok(ace_json::Value::Object(_)))
}

/// No absolute URLs, placeholders, traversal, fragments or alternate API roots.
fn tea_endpoint(endpoint: &str) -> bool {
    static PREFIX: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^(user|repos/[A-Za-z0-9_.%-]+/[A-Za-z0-9_.%-]+)(?:[/?]|$)")
            .expect("the tea prefix pattern compiles")
    });
    static FORBIDDEN: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"[\\#{}\s]").expect("compiles"));
    /// After decoding, a `?` can only have come from `%3F`: never a path character.
    static DECODED_FORBIDDEN: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"[\\?#{}\s]").expect("compiles"));
    static ENCODED: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"(?i)%[0-9a-f]{2}").expect("compiles"));
    if !PREFIX.is_match(endpoint) || FORBIDDEN.is_match(endpoint) {
        return false;
    }
    let Some(path) = endpoint.split('?').next() else {
        return false;
    };
    let decoded = percent_decode(path);
    let Some(decoded) = decoded else {
        return false;
    };
    !decoded.split('/').any(|part| part == "." || part == "..")
        && !DECODED_FORBIDDEN.is_match(&decoded)
        && !ENCODED.is_match(&decoded)
}

/// `decodeURIComponent`, failing on a malformed escape as the JavaScript does.
fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = text.get(index + 1..index + 3)?;
            let byte = u8::from_str_radix(hex, 16).ok()?;
            out.push(byte);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A Bitbucket Cloud `/2.0/` path under `user` or one repository, never an absolute URL,
/// traversal, empty or encoded segment. Reads may carry a plain query; writes may not.
fn bkt_endpoint(endpoint: &str, read: bool) -> bool {
    static PATH: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(
            r"^/2\.0/(?:user|repositories/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*)$",
        )
        .expect("the bkt path pattern compiles")
    });
    static QUERY: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^[A-Za-z0-9_.~%=&+:,-]+$").expect("the bkt query pattern compiles")
    });
    let mut parts = endpoint.split('?');
    let path = parts.next().unwrap_or("");
    let query = parts.next();
    if parts.next().is_some() {
        return false;
    }
    if let Some(query) = query
        && (!read || !QUERY.is_match(query))
    {
        return false;
    }
    PATH.is_match(path)
        && !path
            .split('/')
            .skip(1)
            .any(|part| part.is_empty() || part == "." || part == "..")
}

#[cfg(test)]
mod tests {
    use super::{
        HostCli, ScopedWrite, is_admitted_api_request, is_admitted_write_request,
        is_read_only_api_request, writes_under,
    };
    use crate::transport::command::CommandRequest;

    fn request(command: &str, args: &[&str], input: Option<&str>) -> CommandRequest {
        let mut request = CommandRequest::new(
            command,
            args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>(),
        );
        if let Some(input) = input {
            request = request.with_input(input);
        }
        request
    }

    fn writes() -> Vec<super::HostApiWrite> {
        writes_under(
            "projects/team%2Face",
            &[
                ScopedWrite {
                    method: "POST",
                    path: r"/issues/\d+/notes",
                },
                ScopedWrite {
                    method: "PUT",
                    path: r"/merge_requests/\d+",
                },
            ],
        )
    }

    #[test]
    fn glab_reads_are_exactly_one_get_shape() {
        let read = request(
            "glab",
            &[
                "api",
                "projects/team%2Face",
                "-X",
                "GET",
                "--hostname",
                "gitlab.example",
                "--include",
            ],
            None,
        );
        assert!(is_read_only_api_request(
            HostCli::Glab,
            &read,
            "gitlab.example"
        ));
        for wrong in [
            request(
                "glab",
                &["api", "projects/x", "-X", "POST", "--hostname", "h"],
                None,
            ),
            request(
                "glab",
                &["api", "--hostname", "-X", "GET", "--hostname", "h"],
                None,
            ),
            request(
                "glab",
                &["api", "projects/x", "-X", "GET", "--hostname", "other"],
                None,
            ),
            request(
                "glab",
                &[
                    "api",
                    "projects/x",
                    "-X",
                    "GET",
                    "--hostname",
                    "h",
                    "--field",
                    "x=y",
                ],
                None,
            ),
            request(
                "glab",
                &[
                    "api",
                    "projects/x",
                    "-X",
                    "GET",
                    "--hostname",
                    "h",
                    "--include",
                    "--include",
                ],
                None,
            ),
            request("gh", &["api", "projects/x"], None),
        ] {
            assert!(
                !is_read_only_api_request(HostCli::Glab, &wrong, "h"),
                "{:?}",
                wrong.args
            );
        }
        let with_input = request(
            "glab",
            &["api", "projects/x", "-X", "GET", "--hostname", "h"],
            Some("{}"),
        );
        assert!(!is_read_only_api_request(HostCli::Glab, &with_input, "h"));
    }

    #[test]
    fn tea_and_bkt_and_origin_reads_have_one_shape_each() {
        assert!(is_read_only_api_request(
            HostCli::Tea,
            &request(
                "tea",
                &[
                    "api",
                    "repos/octo/ace/issues",
                    "--method",
                    "GET",
                    "--login",
                    "gitea.example",
                    "--include"
                ],
                None
            ),
            "gitea.example"
        ));
        assert!(!is_read_only_api_request(
            HostCli::Tea,
            &request(
                "tea",
                &[
                    "api",
                    "https://evil.example/x",
                    "--method",
                    "GET",
                    "--login",
                    "gitea.example",
                    "--include"
                ],
                None
            ),
            "gitea.example"
        ));
        assert!(is_read_only_api_request(
            HostCli::Bkt,
            &request(
                "bkt",
                &[
                    "api",
                    "/2.0/repositories/octo/ace/pullrequests?state=OPEN&page=2",
                    "--method",
                    "GET",
                    "--context",
                    "work"
                ],
                None
            ),
            "work"
        ));
        assert!(is_read_only_api_request(
            HostCli::Bkt,
            &request(
                "bkt",
                &[
                    "api",
                    "/2.0/repositories/octo/ace/pullrequests?state=OPEN",
                    "--method",
                    "GET",
                    "--context",
                    "work"
                ],
                None
            ),
            "work"
        ));
        assert!(is_read_only_api_request(
            HostCli::Origin,
            &request(
                "origin",
                &["api", "repos/octo/ace/pulls", "--method", "GET"],
                None
            ),
            ""
        ));
    }

    #[test]
    fn a_raw_query_delimiter_is_allowed_but_an_encoded_one_is_refused() {
        let read = |endpoint: &str| {
            request(
                "tea",
                &[
                    "api",
                    endpoint,
                    "--method",
                    "GET",
                    "--login",
                    "gitea.example",
                    "--include",
                ],
                None,
            )
        };
        assert!(is_read_only_api_request(
            HostCli::Tea,
            &read("repos/octo/ace/issues?state=open"),
            "gitea.example"
        ));
        assert!(!is_read_only_api_request(
            HostCli::Tea,
            &read("repos/octo/ace/issues%3Ffoo"),
            "gitea.example"
        ));
    }

    #[test]
    fn writes_are_admitted_only_inside_one_repository_and_one_shape() {
        let admitted = writes();
        let post = request(
            "glab",
            &[
                "api",
                "projects/team%2Face/issues/12/notes",
                "-X",
                "POST",
                "--hostname",
                "gitlab.example",
                "--include",
                "--input",
                "-",
            ],
            Some(r#"{"body":"x"}"#),
        );
        assert!(is_admitted_write_request(
            HostCli::Glab,
            &post,
            "gitlab.example",
            &admitted
        ));
        let other_repo = request(
            "glab",
            &[
                "api",
                "projects/other/issues/12/notes",
                "-X",
                "POST",
                "--hostname",
                "gitlab.example",
                "--include",
                "--input",
                "-",
            ],
            Some(r#"{"body":"x"}"#),
        );
        assert!(!is_admitted_write_request(
            HostCli::Glab,
            &other_repo,
            "gitlab.example",
            &admitted
        ));
        let no_body = request(
            "glab",
            &[
                "api",
                "projects/team%2Face/issues/12/notes",
                "-X",
                "POST",
                "--hostname",
                "gitlab.example",
                "--include",
                "--input",
                "-",
            ],
            Some("[]"),
        );
        assert!(!is_admitted_write_request(
            HostCli::Glab,
            &no_body,
            "gitlab.example",
            &admitted
        ));
    }

    #[test]
    fn tea_writes_carry_json_on_stdin_and_bkt_writes_keep_a_body_flag() {
        let tea_writes = writes_under(
            "repos/octo/ace",
            &[ScopedWrite {
                method: "POST",
                path: r"/issues",
            }],
        );
        let tea = request(
            "tea",
            &[
                "api",
                "repos/octo/ace/issues",
                "--method",
                "POST",
                "--login",
                "gitea.example",
                "--include",
                "--data",
                "@-",
            ],
            Some(r#"{"title":"x"}"#),
        );
        assert!(is_admitted_write_request(
            HostCli::Tea,
            &tea,
            "gitea.example",
            &tea_writes
        ));
        let bkt_writes = writes_under(
            "/2.0/repositories/octo/ace",
            &[ScopedWrite {
                method: "POST",
                path: r"/pullrequests",
            }],
        );
        let bkt = request(
            "bkt",
            &[
                "api",
                "/2.0/repositories/octo/ace/pullrequests",
                "--method",
                "POST",
                "--context",
                "work",
                "--input",
                r#"{"title":"x"}"#,
            ],
            None,
        );
        assert!(is_admitted_write_request(
            HostCli::Bkt,
            &bkt,
            "work",
            &bkt_writes
        ));
        assert!(!is_admitted_write_request(
            HostCli::Bkt,
            &request(
                "bkt",
                &[
                    "api",
                    "/2.0/repositories/octo/ace/pullrequests",
                    "--method",
                    "POST",
                    "--context",
                    "work"
                ],
                Some("{}")
            ),
            "work",
            &bkt_writes
        ));
        assert!(!is_admitted_write_request(
            HostCli::Origin,
            &request("origin", &["api", "x"], Some("{}")),
            "",
            &bkt_writes
        ));
    }

    #[test]
    fn admission_is_either_a_read_or_a_listed_write() {
        let admitted = writes();
        let read = request(
            "glab",
            &["api", "projects/team%2Face", "-X", "GET", "--hostname", "h"],
            None,
        );
        assert!(is_admitted_api_request(
            HostCli::Glab,
            &read,
            "h",
            &admitted
        ));
        let unknown = request(
            "glab",
            &[
                "api",
                "projects/team%2Face/issues/12/notes",
                "-X",
                "DELETE",
                "--hostname",
                "h",
                "--include",
                "--input",
                "-",
            ],
            Some("{}"),
        );
        assert!(!is_admitted_api_request(
            HostCli::Glab,
            &unknown,
            "h",
            &admitted
        ));
    }
}
