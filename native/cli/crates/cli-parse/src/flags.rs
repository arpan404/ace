// SPDX-License-Identifier: Apache-2.0
//! Reading one flag token against the flags a command takes.

use cli_out::{ErrorCode, FlagValue};
use cli_table::FlagSpec;

use crate::suggest::nearest;

use crate::types::{Line, Problem};

pub(crate) fn is_flag(token: &str) -> bool {
    // A lone `-` and `--` are words; `-1` is a negative number, not a flag.
    let Some(rest) = token.strip_prefix('-') else {
        return false;
    };
    !rest.is_empty()
        && rest != "-"
        && !rest.starts_with(|character: char| character.is_ascii_digit())
}

fn known_names(own: &'static [FlagSpec]) -> Vec<&'static str> {
    let globals = cli_table::global_flags();
    let mut names = Vec::with_capacity(globals.len() + own.len());
    for flag in globals {
        if !flag.hidden {
            names.push(flag.name);
        }
    }
    for flag in own {
        if !flag.hidden && !globals.iter().any(|global| global.name == flag.name) {
            names.push(flag.name);
        }
    }
    names
}

fn flag_by_name(own: &'static [FlagSpec], name: &str) -> Option<&'static FlagSpec> {
    own.iter().find(|flag| flag.name == name).or_else(|| {
        cli_table::global_flags()
            .iter()
            .find(|flag| flag.name == name)
    })
}

fn flag_by_short(own: &'static [FlagSpec], short: &str) -> Option<&'static FlagSpec> {
    own.iter()
        .find(|flag| flag.short == Some(short))
        .or_else(|| {
            cli_table::global_flags()
                .iter()
                .find(|flag| flag.short == Some(short))
        })
}

fn missing_value(shown: &str, placeholder: &str) -> Problem {
    Problem::new(
        ErrorCode::MissingArgument,
        format!("{shown} needs a value: {placeholder}."),
    )
    .with_argument(shown)
}

fn given_twice(shown: &str) -> Problem {
    Problem::new(ErrorCode::BadArgument, format!("{shown} is given twice.")).with_argument(shown)
}

/// Reads the flag at `index`; returns the next index, or the problem with it.
pub(crate) fn take_flag<'a>(
    input: &[&'a str],
    index: usize,
    own: &'static [FlagSpec],
    line: &mut Line<'a>,
    renames: &[(&str, &str)],
) -> Result<usize, Problem> {
    let token = input[index];
    let long = token.starts_with("--");
    let body = if long { &token[2..] } else { &token[1..] };
    let (raw_name, inline) = match body.split_once('=') {
        Some((name, value)) => (name, Some(value)),
        None => (body, None),
    };
    if !long && raw_name.len() > 1 && inline.is_none() {
        // `-qy`: several one-letter switches together.
        let mut specs = Vec::with_capacity(raw_name.len());
        for (offset, letter) in raw_name.char_indices() {
            let letter = &raw_name[offset..offset + letter.len_utf8()];
            specs.push(flag_by_short(own, letter));
        }
        if specs
            .iter()
            .all(|spec| spec.is_some_and(|flag| flag.value.is_none()))
        {
            for spec in specs.into_iter().flatten() {
                line.flags.set(spec.name, FlagValue::Switch);
            }
            return Ok(index + 1);
        }
    }
    let name = renames
        .iter()
        .find(|(old, _)| *old == raw_name)
        .map_or(raw_name, |(_, new)| *new);
    let spec = if long {
        flag_by_name(own, name)
    } else {
        flag_by_short(own, name)
    };
    let Some(spec) = spec else {
        let suggestion = long
            .then(|| nearest(name, known_names(own)).map(|name| format!("--{name}")))
            .flatten();
        let shown = token.split_once('=').map_or(token, |(head, _)| head);
        let hint = suggestion.as_ref().map_or_else(
            || "See its flags with --help.".to_owned(),
            |name| format!("Did you mean {name}?"),
        );
        let problem = Problem::new(
            ErrorCode::UnknownFlag,
            format!("{shown} isn't a flag this command takes."),
        )
        .with_argument(shown)
        .with_hint(hint);
        return Err(match suggestion {
            Some(suggestion) => problem.with_suggestion(suggestion),
            None => problem,
        });
    };
    apply_flag(input, index, spec, inline, line)
}

/// Reads a known flag's switch or value.
fn apply_flag<'a>(
    input: &[&'a str],
    index: usize,
    spec: &'static FlagSpec,
    inline: Option<&'a str>,
    line: &mut Line<'a>,
) -> Result<usize, Problem> {
    let shown = format!("--{}", spec.name);
    let Some(placeholder) = spec.value else {
        if inline.is_some() {
            return Err(
                Problem::new(ErrorCode::BadArgument, format!("{shown} takes no value."))
                    .with_argument(&shown),
            );
        }
        if line.flags.has(spec.name) && !spec.repeat {
            return Err(given_twice(&shown));
        }
        line.flags.set(spec.name, FlagValue::Switch);
        return Ok(index + 1);
    };
    let value = match inline {
        Some(value) => Some(value),
        None => input.get(index + 1).copied(),
    };
    let Some(value) = value else {
        return Err(missing_value(&shown, placeholder));
    };
    if inline.is_none() && value.starts_with("--") {
        return Err(missing_value(&shown, placeholder));
    }
    if !spec.choices.is_empty() && !spec.choices.contains(&value) {
        return Err(Problem::new(
            ErrorCode::BadArgument,
            format!("{shown} takes {}, not {value}.", spec.choices.join(", ")),
        )
        .with_argument(&shown));
    }
    if spec.repeat {
        match line.lists.iter_mut().find(|(flag, _)| *flag == spec.name) {
            Some((_, values)) => values.push(value),
            None => line.lists.push((spec.name, vec![value])),
        }
    } else if line.flags.has(spec.name) {
        return Err(given_twice(&shown));
    }
    line.flags.set(spec.name, FlagValue::Value(value));
    Ok(index + if inline.is_some() { 1 } else { 2 })
}
