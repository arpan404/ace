//! tldr-pages (CC BY 4.0, <https://github.com/tldr-pages/tldr>), the public command corpus the
//! classifier is trained and measured on besides its own templates (ADR 0172, amendment 1). Read
//! from a checkout at a pinned commit (`fetch-corpora.sh`); nothing of it is committed here. Each
//! example's `{{placeholders}}` are filled with plain values from the bot's folder, and a
//! `{{[-s|--long]}}` alternative gives one command per form.

use std::path::Path;

/// The commit the shipped model was trained on; `fetch-corpora.sh` checks it out.
pub const COMMIT: &str = "70eef449485e3240f3bd00f02734fe12257ed735";

/// The platforms read: the ones Spade runs commands on.
const PLATFORMS: &[&str] = &["common", "linux", "osx"];

/// One filled example.
#[derive(Debug, Clone)]
pub struct Example {
    /// The page (the program), e.g. `git-push`.
    pub page: String,
    pub description: String,
    pub command: String,
}

/// Every example of every page under `dir/pages/{common,linux,osx}`, in a fixed order.
pub fn read(dir: &Path) -> Result<Vec<Example>, String> {
    let mut out = Vec::new();
    for platform in PLATFORMS {
        let folder = dir.join("pages").join(platform);
        let mut names: Vec<_> = std::fs::read_dir(&folder)
            .map_err(|e| format!("{}: {e}", folder.display()))?
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "md"))
            .collect();
        names.sort();
        for path in names {
            let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let page = path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            parse(&page, &text, &mut out);
        }
    }
    Ok(out)
}

fn parse(page: &str, text: &str, out: &mut Vec<Example>) {
    let mut description = String::new();
    for line in text.lines() {
        if let Some(d) = line.strip_prefix("- ") {
            description = d.trim_end_matches(':').to_owned();
        } else if let Some(code) = line.strip_prefix('`').and_then(|l| l.strip_suffix('`')) {
            let mut seen = Vec::new();
            for form in 0..2 {
                let command = fill(code, form);
                if !command.trim().is_empty() && !seen.contains(&command) {
                    seen.push(command.clone());
                    out.push(Example {
                        page: page.to_owned(),
                        description: description.clone(),
                        command,
                    });
                }
            }
        }
    }
}

/// `template` with each placeholder filled; `form` picks the short (0) or long (1) side of an
/// alternative.
pub fn fill(template: &str, form: usize) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            out.push_str(&rest[start..]);
            return out;
        };
        // `{{}}}` and the like: the closing braces belong to the value.
        let mut end = end;
        while after[end + 2..].starts_with('}') {
            end += 1;
        }
        out.push_str(&value(&after[..end], form));
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

fn value(inner: &str, form: usize) -> String {
    if inner.is_empty() {
        return "{}".to_owned();
    }
    if let Some(choices) = inner.strip_prefix('[').and_then(|i| i.strip_suffix(']')) {
        let options: Vec<&str> = choices.split('|').collect();
        return options[form.min(options.len() - 1)].to_owned();
    }
    // A list (`path/to/file1 path/to/file2 ...`): the first one or two.
    let mut items: Vec<&str> = inner
        .split_whitespace()
        .filter(|w| *w != "..." && *w != "…")
        .collect();
    if items.is_empty() {
        return String::new();
    }
    items.truncate(1 + form.min(1));
    items
        .iter()
        .map(|item| one(item))
        .collect::<Vec<_>>()
        .join(" ")
}

fn one(item: &str) -> String {
    let lower = item.to_ascii_lowercase();
    if let Some(rest) = item.strip_prefix("path/to/") {
        let rest = rest.trim_end_matches(['1', '2', '3']);
        return if rest.is_empty() || rest == "directory" || rest == "dir" || rest == "folder" {
            "src".to_owned()
        } else if rest == "file" || rest == "file_or_directory" {
            "src/main.rs".to_owned()
        } else {
            format!("src/{rest}")
        };
    }
    if item.starts_with('/') || item.starts_with('~') || item.starts_with('.') {
        return item.to_owned();
    }
    if item.contains("://") || item.contains('.') && !item.contains('_') {
        return item.to_owned();
    }
    let digits = lower.trim_end_matches(char::is_numeric);
    match digits {
        "file" | "filename" | "input" | "input_file" | "source" => "notes.txt",
        "directory" | "dir" | "folder" => "src",
        "command" | "cmd" => "ls",
        "username" | "user" | "user_name" | "login" => "sam",
        "password" | "passphrase" => "hunter2",
        "package" | "package_name" | "pkg" | "module" | "crate" | "gem" | "formula" => "left-pad",
        "host" | "hostname" | "domain" | "server" | "remote_host" => "example.com",
        "port" => "8080",
        "n" | "number" | "count" | "num" | "lines" | "size" | "width" | "height" | "seconds" => "5",
        "process_id" | "pid" => "4242",
        "ip_address" | "ip" | "address" => "192.168.1.10",
        "url" => "https://example.com",
        "email" | "email_address" => "sam@example.com",
        "branch" | "branch_name" | "local_branch" | "remote_branch" => "feature",
        "remote" | "remote_name" => "origin",
        "message" | "commit_message" | "text" | "string" | "title" | "body" => "'fix typo'",
        "version" | "tag" => "1.2.0",
        "pattern" | "regex" | "regular_expression" | "search_pattern" | "keyword" | "query" => {
            "TODO"
        }
        "name" | "project_name" | "container_name" | "image" | "image_name" | "target"
        | "service" | "unit" | "key" | "value" | "repository" | "repo" | "database_name" => "demo",
        _ => return item.replace(['<', '>'], ""),
    }
    .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders_fill_with_plain_values_and_alternatives_give_both_forms() {
        assert_eq!(
            fill(
                "git push {{[-u|--set-upstream]}} {{remote_name}} {{local_branch}}",
                0
            ),
            "git push -u origin feature"
        );
        assert_eq!(
            fill(
                "git push {{[-u|--set-upstream]}} {{remote_name}} {{local_branch}}",
                1
            ),
            "git push --set-upstream origin feature"
        );
        assert_eq!(fill("cat {{path/to/file}}", 0), "cat src/main.rs");
        assert_eq!(
            fill("find . -exec rm {{}} \\;", 0),
            "find . -exec rm {} \\;"
        );
        assert_eq!(
            fill("curl {{https://example.com}}", 0),
            "curl https://example.com"
        );
        assert_eq!(
            fill("rm {{path/to/file1 path/to/file2 ...}}", 1),
            "rm src/main.rs src/main.rs"
        );
    }

    #[test]
    fn a_page_gives_each_example_with_its_description() {
        let mut out = Vec::new();
        parse(
            "git-status",
            "# git status\n\n> Show changes.\n\n- Show changed files:\n\n`git status`\n\n- Short:\n\n`git status {{[-s|--short]}}`\n",
            &mut out,
        );
        let commands: Vec<_> = out.iter().map(|e| e.command.as_str()).collect();
        assert_eq!(
            commands,
            ["git status", "git status -s", "git status --short"]
        );
        assert_eq!(out[0].description, "Show changed files");
    }
}
