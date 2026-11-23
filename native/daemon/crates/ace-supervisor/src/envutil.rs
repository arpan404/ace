// SPDX-License-Identifier: Apache-2.0
//! Storage bounds for an environment ace launches: cheap per-string maxima a
//! schema checks first. Ports `process-env.ts`; the kernel's own check stays
//! the launch's, this only refuses what cannot start.

/// Cheap per-string maxima one exec accepts: `string` bounds one
/// `NAME=value` with its terminator, `block` the whole environment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LaunchLimits {
    /// Byte size unit: UTF-8 bytes on POSIX, UTF-16 units on Windows.
    pub utf8: bool,
    /// One `NAME=value` with its terminator.
    pub string: usize,
    /// The environment's share of the exec limit.
    pub block: usize,
}

/// Left of ARG_MAX for a launch's own arguments and their pointers.
pub const ARGV_RESERVE: usize = 131_072;
const POINTER: usize = 8;

/// Per-platform exec limits: Linux (MAX_ARG_STRLEN, ARG_MAX), macOS ARG_MAX,
/// Windows (32,767 UTF-16 units per variable, a 2 MiB bound for the block).
pub fn launch_limits(platform: &str) -> LaunchLimits {
    if platform == "linux" {
        return LaunchLimits {
            utf8: true,
            string: 131_072,
            block: 2_097_152 - ARGV_RESERVE,
        };
    }
    if platform == "win32" {
        return LaunchLimits {
            utf8: false,
            string: 32_767,
            block: 2_097_152,
        };
    }
    let block = 1_048_576 - ARGV_RESERVE;
    LaunchLimits {
        utf8: true,
        string: block - 2 * POINTER,
        block,
    }
}

/// Byte length of `entry` in the platform's encoding, with its terminator.
fn entry_size(entry: &str, utf8: bool) -> usize {
    if utf8 {
        entry.len() + 1
    } else {
        entry.encode_utf16().count() + 1
    }
}

/// Why `env` can't be launched on `platform`, or `None` when it can. Counts
/// what an exec counts: each set variable's `NAME=value` and terminator, and
/// on POSIX a pointer for each plus one ending the list. A masked (`None`)
/// variable isn't launched.
pub fn environment_launch_error(
    env: &[(String, Option<String>)],
    platform: &str,
) -> Option<String> {
    let limits = launch_limits(platform);
    let unit = if limits.utf8 { "bytes" } else { "UTF-16 units" };
    let mut block = if limits.utf8 { POINTER } else { 0 };
    for (name, value) in env {
        let Some(value) = value else {
            continue;
        };
        let entry = format!("{name}={value}");
        let size = entry_size(&entry, limits.utf8);
        if size > limits.string {
            return Some(format!(
                "Variable {name} is {size} {unit} with its terminator, over the {} a process can start with",
                limits.string
            ));
        }
        block += size + if limits.utf8 { POINTER } else { 0 };
    }
    if block > limits.block {
        return Some(format!(
            "The environment is {block} {unit}, over the {} a process can start with",
            limits.block
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn variable(name: &str, bytes: usize) -> Vec<(String, Option<String>)> {
        vec![(name.to_owned(), Some("x".repeat(bytes - name.len() - 2)))]
    }

    fn block_of_bytes(budget: usize, chunk: usize) -> Vec<(String, Option<String>)> {
        let count = (budget - 8).div_ceil(chunk + 8);
        let strings = budget - 8 - 8 * count;
        let mut env = Vec::with_capacity(count);
        for index in 0..count {
            let size = strings / count + if index == 0 { strings % count } else { 0 };
            let name = format!("V{index}");
            let value = "x".repeat(size - name.len() - 2);
            env.push((name, Some(value)));
        }
        env
    }

    #[test]
    fn variable_at_limit_launches_one_more_does_not() {
        for platform in ["linux", "darwin", "win32"] {
            let limits = launch_limits(platform);
            assert!(
                environment_launch_error(&variable("AT_LIMIT", limits.string), platform).is_none(),
                "{platform}"
            );
            assert!(
                environment_launch_error(&variable("AT_LIMIT", limits.string + 1), platform)
                    .is_some_and(|message| message.contains("AT_LIMIT")),
                "{platform}"
            );
        }
    }

    #[test]
    fn linux_counts_utf8_bytes_not_characters() {
        let limits = launch_limits("linux");
        let half = (limits.string - "E=".len()) / 2;
        let value = "é".repeat(half);
        assert!(
            environment_launch_error(&[("E".to_owned(), Some(value))], "linux")
                .is_some_and(|message| message.contains('E'))
        );
        let value = "é".repeat(half - 1);
        assert!(environment_launch_error(&[("E".to_owned(), Some(value))], "linux").is_none());
    }

    #[test]
    fn windows_counts_utf16_units() {
        let limits = launch_limits("win32");
        let value = "é".repeat(limits.string - "E=".len() - 1);
        assert!(environment_launch_error(&[("E".to_owned(), Some(value))], "win32").is_none());
        let value = "é".repeat(limits.string - "E=".len());
        assert!(
            environment_launch_error(&[("E".to_owned(), Some(value))], "win32")
                .is_some_and(|message| message.contains('E'))
        );
    }

    #[test]
    fn block_at_budget_launches_one_more_does_not() {
        for platform in ["linux", "darwin"] {
            let limits = launch_limits(platform);
            let env = block_of_bytes(limits.block, 100_000.min(limits.string));
            assert!(
                environment_launch_error(&env, platform).is_none(),
                "{platform}"
            );
            let (first, rest) = env.split_first().expect("block is not empty");
            let mut over = vec![(
                first.0.clone(),
                Some(format!("{}x", first.1.as_ref().expect("set"))),
            )];
            over.extend(rest.iter().cloned());
            assert!(
                environment_launch_error(&over, platform)
                    .is_some_and(|message| message.contains("environment")),
                "{platform}"
            );
        }
    }

    #[test]
    fn masked_variable_is_not_launched() {
        let limits = launch_limits("linux");
        let mut env = variable("A", limits.string);
        env.push(("MASKED".to_owned(), None));
        assert!(environment_launch_error(&env, "linux").is_none());
    }
}
