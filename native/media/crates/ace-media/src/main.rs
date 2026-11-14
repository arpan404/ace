// SPDX-License-Identifier: Apache-2.0

use std::io::{self, Write};

const VERSION: &str = match option_env!("ACE_MEDIA_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

fn run(argument: Option<&str>, output: &mut impl Write) -> io::Result<()> {
    if argument == Some("--version") {
        writeln!(output, "{VERSION}")?;
    }
    Ok(())
}

fn main() -> io::Result<()> {
    run(std::env::args().nth(1).as_deref(), &mut io::stdout().lock())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_flag_prints_only_the_version_and_normal_launch_stays_silent() -> io::Result<()> {
        let mut output = Vec::new();
        run(Some("--version"), &mut output)?;
        assert_eq!(output, format!("{VERSION}\n").as_bytes());
        output.clear();
        run(None, &mut output)?;
        assert!(output.is_empty());
        Ok(())
    }
}
