// SPDX-License-Identifier: Apache-2.0
//! Pure pieces of the Windows launch, kept here so every platform tests them.
#![cfg_attr(not(windows), allow(dead_code))]

/// A Windows command line that the Microsoft C runtime splits back into `program` and `args`
/// exactly: arguments with spaces, tabs or quotes are quoted, backslashes before a quote are
/// doubled and the quote escaped, trailing backslashes inside quotes doubled.
pub fn windows_command_line(program: &str, args: &[String]) -> String {
    // A path can't contain a quote, so the program only needs quoting.
    let mut line = format!("\"{program}\"");
    for arg in args {
        line.push(' ');
        if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\u{b}', '"']) {
            line.push_str(arg);
            continue;
        }
        line.push('"');
        let mut backslashes = 0;
        for ch in arg.chars() {
            match ch {
                '\\' => backslashes += 1,
                '"' => {
                    line.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                    line.push('"');
                    backslashes = 0;
                }
                _ => {
                    line.extend(std::iter::repeat_n('\\', backslashes));
                    line.push(ch);
                    backslashes = 0;
                }
            }
        }
        line.extend(std::iter::repeat_n('\\', backslashes * 2));
        line.push('"');
    }
    line
}

/// C runtime descriptor flags (`FOPEN`, `FPIPE`, `FDEV`).
const FOPEN: u8 = 0x01;
const FPIPE: u8 = 0x08;
const FDEV: u8 = 0x40;

/// The `lpReserved2` block that hands descriptors 0..n to a child's C runtime: a
/// little-endian `i32` count, a flag byte per descriptor, then each handle as a pointer-sized
/// value, packed. Descriptors 0–2 are character devices (`NUL`), the rest pipes.
pub fn crt_fd_table(handles: &[usize]) -> Vec<u8> {
    let mut table = Vec::with_capacity(4 + handles.len() * (1 + size_of::<usize>()));
    table.extend_from_slice(&(handles.len() as i32).to_le_bytes());
    for fd in 0..handles.len() {
        table.push(if fd < 3 { FOPEN | FDEV } else { FOPEN | FPIPE });
    }
    for handle in handles {
        table.extend_from_slice(&handle.to_le_bytes());
    }
    table
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The C runtime's splitting rules, as documented for `CommandLineToArgvW`/the CRT.
    fn split(line: &str) -> Vec<String> {
        let mut args = Vec::new();
        let mut chars = line.chars().peekable();
        loop {
            while chars.peek().is_some_and(|c| *c == ' ' || *c == '\t') {
                chars.next();
            }
            if chars.peek().is_none() {
                return args;
            }
            let (mut arg, mut quoted, mut backslashes) = (String::new(), false, 0usize);
            while let Some(&ch) = chars.peek() {
                if !quoted && (ch == ' ' || ch == '\t') {
                    break;
                }
                chars.next();
                match ch {
                    '\\' => backslashes += 1,
                    '"' => {
                        arg.extend(std::iter::repeat_n('\\', backslashes / 2));
                        if backslashes % 2 == 1 {
                            arg.push('"');
                        } else {
                            quoted = !quoted;
                        }
                        backslashes = 0;
                    }
                    _ => {
                        arg.extend(std::iter::repeat_n('\\', backslashes));
                        backslashes = 0;
                        arg.push(ch);
                    }
                }
            }
            arg.extend(std::iter::repeat_n('\\', backslashes));
            args.push(arg);
        }
    }

    #[test]
    fn arguments_survive_the_c_runtime_split() {
        let args: Vec<String> = [
            "--user-data-dir=C:\\Users\\a b\\profile",
            "plain",
            "",
            "ends with\\",
            "quote\"inside",
            "back\\\\\"slashes",
            "C:\\no-spaces\\",
        ]
        .map(String::from)
        .to_vec();
        let line = windows_command_line("C:\\Program Files\\Chrome\\chrome.exe", &args);
        let mut parsed = split(&line);
        assert_eq!(parsed.remove(0), "C:\\Program Files\\Chrome\\chrome.exe");
        assert_eq!(parsed, args);
    }

    #[test]
    fn the_descriptor_table_is_count_then_flags_then_handles() {
        let table = crt_fd_table(&[10, 11, 12, 13, 14]);
        let word = size_of::<usize>();
        assert_eq!(table.len(), 4 + 5 + 5 * word);
        assert_eq!(&table[..4], &5i32.to_le_bytes());
        assert_eq!(&table[4..9], &[0x41, 0x41, 0x41, 0x09, 0x09]);
        assert_eq!(&table[9 + 3 * word..9 + 4 * word], &13usize.to_le_bytes());
    }
}
