//! What `make` would run, read from the makefile without running it: the selected goals (the
//! default goal when none) and what they depend on, with variables and automatic variables
//! expanded, `include`s followed. Only that part of the graph is checked, so a `deploy` target
//! next to `test` doesn't make `make test` ask. What it can't read (`$(shell)`, `$(eval)`,
//! `$(call)`, `!=`, an include through a variable) is unclear.

use std::collections::{HashMap, HashSet};

/// Why a makefile can't be read for what it runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Unread {
    /// It uses something Spade doesn't follow.
    Unclear,
    /// A file it needs couldn't be shown.
    Unseen,
}

#[derive(Debug, Default, Clone)]
struct Rule {
    prereqs: Vec<String>,
    recipe: Vec<String>,
}

#[derive(Debug, Default)]
struct Makefile {
    vars: HashMap<String, String>,
    rules: HashMap<String, Rule>,
    /// `(target pattern, rule)`, for targets with no rule of their own.
    patterns: Vec<(String, Rule)>,
    default: Option<String>,
}

/// Deepest `include` followed, and deepest variable expansion.
const DEEPEST: usize = 8;

/// Functions whose result Spade can't know without running something.
const UNREAD: &[&str] = &["shell", "eval", "call", "file", "value", "guile"];

/// The recipe lines `goals` would run, expanded, in order. `read` fetches a file by its name
/// relative to the makefile's folder (and shows it); `None` when it can't be shown.
pub(super) fn recipes(
    first: &str,
    goals: &[String],
    vars: &[(String, String)],
    read: &mut dyn FnMut(&str) -> Option<String>,
) -> Result<Vec<String>, Unread> {
    let mut make = Makefile::default();
    let text = read(first).ok_or(Unread::Unseen)?;
    load(&mut make, &text, read, 0)?;
    for (name, value) in vars {
        make.vars.insert(name.clone(), value.clone());
    }
    let goals: Vec<String> = if goals.is_empty() {
        make.default.clone().into_iter().collect()
    } else {
        goals.to_vec()
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut queue: Vec<String> = goals;
    while let Some(target) = queue.pop() {
        if !seen.insert(target.clone()) {
            continue;
        }
        let Some((rule, stem)) = rule_for(&make, &target) else {
            continue;
        };
        let prereqs: Vec<String> = rule
            .prereqs
            .iter()
            .map(|p| expand(&make, &p.replace('%', &stem), &Auto::none(), 0))
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .flat_map(|p| p.split_whitespace().map(str::to_owned).collect::<Vec<_>>())
            .filter(|p| p != "|")
            .collect();
        let auto = Auto {
            target: target.clone(),
            first: prereqs.first().cloned().unwrap_or_default(),
            all: prereqs.join(" "),
            stem: stem.clone(),
        };
        for line in &rule.recipe {
            let line = line.trim().trim_start_matches(['@', '-', '+']).trim();
            if line.is_empty() {
                continue;
            }
            out.push(expand(&make, line, &auto, 0)?);
        }
        queue.extend(prereqs.into_iter().rev());
    }
    Ok(out)
}

/// The rule for `target`: its own, else the first pattern rule that matches, with the stem.
fn rule_for(make: &Makefile, target: &str) -> Option<(Rule, String)> {
    if let Some(rule) = make.rules.get(target)
        && (!rule.recipe.is_empty() || !pattern_matches(make, target))
    {
        return Some((rule.clone(), String::new()));
    }
    let own = make.rules.get(target).cloned().unwrap_or_default();
    make.patterns.iter().find_map(|(pattern, rule)| {
        let (before, after) = pattern.split_once('%')?;
        let stem = target.strip_prefix(before)?.strip_suffix(after)?;
        let mut rule = rule.clone();
        rule.prereqs.extend(own.prereqs.iter().cloned());
        Some((rule, stem.to_owned()))
    })
}

fn pattern_matches(make: &Makefile, target: &str) -> bool {
    make.patterns.iter().any(|(pattern, _)| {
        pattern.split_once('%').is_some_and(|(before, after)| {
            target.len() >= before.len() + after.len()
                && target.starts_with(before)
                && target.ends_with(after)
        })
    })
}

fn load(
    make: &mut Makefile,
    text: &str,
    read: &mut dyn FnMut(&str) -> Option<String>,
    depth: usize,
) -> Result<(), Unread> {
    if depth > DEEPEST {
        return Err(Unread::Unclear);
    }
    let joined = text.replace("\\\r\n", " ").replace("\\\n", " ");
    let mut current: Option<Vec<String>> = None;
    let mut defining: Option<(String, Vec<String>)> = None;
    for line in joined.lines() {
        if let Some((name, body)) = &mut defining {
            if line.trim() == "endef" {
                let value = body.join("\n");
                make.vars.insert(name.clone(), value);
                defining = None;
            } else {
                body.push(line.to_owned());
            }
            continue;
        }
        if line.starts_with('\t') {
            if let Some(targets) = &current {
                for target in targets {
                    push_recipe(make, target, line);
                }
            }
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let lowered = trimmed.to_lowercase();
        if UNREAD
            .iter()
            .any(|f| lowered.contains(&format!("$({f} ")) || lowered.contains(&format!("${{{f} ")))
        {
            return Err(Unread::Unclear);
        }
        let word = trimmed.split_whitespace().next().unwrap_or("");
        match word {
            "ifeq" | "ifneq" | "ifdef" | "ifndef" | "else" | "endif" | "vpath" | "unexport" => {
                continue;
            }
            "define" => {
                let name = trimmed["define".len()..]
                    .trim()
                    .trim_end_matches(['=', ':', '?', '+', '!'])
                    .trim();
                defining = Some((name.to_owned(), Vec::new()));
                current = None;
                continue;
            }
            "include" | "-include" | "sinclude" => {
                let required = word == "include";
                for name in trimmed[word.len()..].split_whitespace() {
                    if name.contains(['$', '*', '?', '[']) {
                        return Err(Unread::Unclear);
                    }
                    match read(name) {
                        Some(text) => load(make, &text, read, depth + 1)?,
                        None if required => return Err(Unread::Unseen),
                        None => {}
                    }
                }
                current = None;
                continue;
            }
            _ => {}
        }
        let line = trimmed
            .strip_prefix("export ")
            .or_else(|| trimmed.strip_prefix("override "))
            .unwrap_or(trimmed);
        if let Some((name, op, value)) = assignment(line) {
            if op == "!=" {
                return Err(Unread::Unclear);
            }
            let value = if op.starts_with(':') {
                expand(make, value, &Auto::none(), 0)?
            } else {
                value.to_owned()
            };
            match op {
                "+=" => {
                    let before = make.vars.get(name).cloned().unwrap_or_default();
                    make.vars.insert(
                        name.to_owned(),
                        format!("{before} {value}").trim().to_owned(),
                    );
                }
                "?=" => {
                    make.vars.entry(name.to_owned()).or_insert(value);
                }
                _ => {
                    make.vars.insert(name.to_owned(), value);
                }
            }
            current = None;
            continue;
        }
        let Some((targets, rest)) = line.split_once(':') else {
            current = None;
            continue;
        };
        let rest = rest.trim_start_matches(':');
        // `target: VAR = value` sets a variable for that target only.
        let (prereqs, inline) = match rest.split_once(';') {
            Some((prereqs, recipe)) => (prereqs, Some(recipe)),
            None => (rest, None),
        };
        if prereqs.contains('=') {
            current = None;
            continue;
        }
        let targets = expand(make, targets, &Auto::none(), 0)?;
        let targets: Vec<String> = targets.split_whitespace().map(str::to_owned).collect();
        for target in &targets {
            if target.contains('%') {
                make.patterns.push((
                    target.clone(),
                    Rule {
                        prereqs: prereqs.split_whitespace().map(str::to_owned).collect(),
                        recipe: Vec::new(),
                    },
                ));
                continue;
            }
            let rule = make.rules.entry(target.clone()).or_default();
            rule.prereqs
                .extend(prereqs.split_whitespace().map(str::to_owned));
            if make.default.is_none() && !target.starts_with('.') {
                make.default = Some(target.clone());
            }
        }
        if let Some(recipe) = inline {
            for target in &targets {
                push_recipe(make, target, recipe);
            }
        }
        current = Some(targets);
    }
    Ok(())
}

fn push_recipe(make: &mut Makefile, target: &str, line: &str) {
    if target.contains('%') {
        if let Some((_, rule)) = make
            .patterns
            .iter_mut()
            .rev()
            .find(|(pattern, _)| pattern == target)
        {
            rule.recipe.push(line.to_owned());
        }
        return;
    }
    make.rules
        .entry(target.to_owned())
        .or_default()
        .recipe
        .push(line.to_owned());
}

/// `NAME op value`, for the assignment operators make has.
fn assignment(line: &str) -> Option<(&str, &str, &str)> {
    let at = line.find('=')?;
    let colon = line.find(':');
    let (head, value) = line.split_at(at);
    let value = value[1..].trim();
    let op_start = head
        .trim_end()
        .rfind(|c: char| !matches!(c, ':' | '?' | '+' | '!'))
        .map_or(0, |i| i + 1);
    let head = head.trim_end();
    let (name, op) = head.split_at(op_start.min(head.len()));
    let op = match op {
        "" => "=",
        ":" | "::" | ":::" => ":=",
        "?" => "?=",
        "+" => "+=",
        "!" => "!=",
        _ => return None,
    };
    // A colon before the `=` that isn't part of the operator makes it a rule.
    if colon.is_some_and(|c| c < name.len()) {
        return None;
    }
    let name = name.trim();
    if name.is_empty() || name.contains(char::is_whitespace) {
        return None;
    }
    Some((name, op, value))
}

/// The automatic variables of the rule being run.
struct Auto {
    target: String,
    first: String,
    all: String,
    stem: String,
}

impl Auto {
    fn none() -> Self {
        Self {
            target: String::new(),
            first: String::new(),
            all: String::new(),
            stem: String::new(),
        }
    }
}

/// `text` with make's variables expanded. A function Spade can't know the result of is unclear;
/// other functions become a placeholder word.
fn expand(make: &Makefile, text: &str, auto: &Auto, depth: usize) -> Result<String, Unread> {
    if depth > DEEPEST {
        return Err(Unread::Unclear);
    }
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '$' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let Some(&next) = chars.get(i + 1) else {
            out.push('$');
            break;
        };
        match next {
            '$' => {
                out.push('$');
                i += 2;
            }
            '(' | '{' => {
                let close = if next == '(' { ')' } else { '}' };
                let mut level = 0;
                let mut end = None;
                for (at, &c) in chars.iter().enumerate().skip(i + 1) {
                    if c == next {
                        level += 1;
                    } else if c == close {
                        level -= 1;
                        if level == 0 {
                            end = Some(at);
                            break;
                        }
                    }
                }
                let end = end.ok_or(Unread::Unclear)?;
                let inner: String = chars[i + 2..end].iter().collect();
                let inner = expand(make, &inner, auto, depth + 1)?;
                if let Some((function, _)) = inner.split_once(char::is_whitespace) {
                    if UNREAD.contains(&function) {
                        return Err(Unread::Unclear);
                    }
                    out.push('_');
                } else {
                    out.push_str(&variable(make, &inner, auto, depth)?);
                }
                i = end + 1;
            }
            c => {
                out.push_str(&variable(make, &c.to_string(), auto, depth)?);
                i += 2;
            }
        }
    }
    Ok(out)
}

fn variable(make: &Makefile, name: &str, auto: &Auto, depth: usize) -> Result<String, Unread> {
    Ok(match name {
        "@" => auto.target.clone(),
        "<" => auto.first.clone(),
        "^" | "+" | "?" => auto.all.clone(),
        "*" => auto.stem.clone(),
        "MAKE" => "make".to_owned(),
        _ => match make.vars.get(name) {
            Some(value) => expand(make, value, auto, depth + 1)?,
            None => String::new(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(text: &str, goals: &[&str]) -> Result<Vec<String>, Unread> {
        let files: HashMap<&str, &str> =
            [("Makefile", text), ("rules.mk", "deploy:\n\tgit push\n")]
                .into_iter()
                .collect();
        let goals: Vec<String> = goals.iter().map(|g| (*g).to_owned()).collect();
        recipes("Makefile", &goals, &[], &mut |name| {
            files.get(name).map(|t| (*t).to_owned())
        })
    }

    #[test]
    fn only_the_goals_graph_is_read_with_variables_expanded() {
        let text = "CC = cc\nOUT := app\nall: $(OUT)\n$(OUT): main.o\n\t$(CC) -o $@ $^\n\
                    %.o: %.c\n\t@$(CC) -c $< -o $@\ntest:\n\tcargo test\ndeploy:\n\tgit push\n";
        assert_eq!(
            run(text, &[]),
            Ok(vec![
                "cc -o app main.o".to_owned(),
                "cc -c main.c -o main.o".to_owned()
            ])
        );
        assert_eq!(run(text, &["test"]), Ok(vec!["cargo test".to_owned()]));
        assert_eq!(run(text, &["deploy"]), Ok(vec!["git push".to_owned()]));
    }

    #[test]
    fn includes_are_followed_and_what_make_cant_say_without_running_is_unclear() {
        assert_eq!(
            run("include rules.mk\n", &["deploy"]),
            Ok(vec!["git push".to_owned()])
        );
        assert_eq!(
            run("include missing.mk\nall:\n\ttrue\n", &[]),
            Err(Unread::Unseen)
        );
        assert_eq!(
            run("-include missing.mk\nall:\n\ttrue\n", &[]),
            Ok(vec!["true".to_owned()])
        );
        for text in [
            "V := $(shell git describe)\nall:\n\techo $(V)\n",
            "$(eval X = 1)\nall:\n\ttrue\n",
            "all:\n\t$(call run,x)\n",
            "V != date\nall:\n\ttrue\n",
            "include $(wildcard *.mk)\nall:\n\ttrue\n",
        ] {
            assert_eq!(run(text, &[]), Err(Unread::Unclear), "{text}");
        }
    }
}
