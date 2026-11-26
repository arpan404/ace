// SPDX-License-Identifier: Apache-2.0
//! The name a computer was given (`apps/daemon/src/computer-name.ts`): macOS's Computer Name,
//! Linux's `PRETTY_HOSTNAME`, and the hostname fallback, bounded and injected for tests.

/// A name host: where the OS keeps the name the person gave this computer (`computer-name.ts:5`).
pub trait NameHost {
    /// `darwin`, `linux`, `win32`, as Node names it.
    fn platform(&self) -> &str;
    /// macOS: `scutil --get ComputerName`, empty when unavailable.
    fn mac_name(&self) -> Option<String>;
    /// Linux: `/etc/machine-info`, where GNOME Settings and hostnamectl keep it.
    fn machine_info(&self) -> Option<String>;
    fn hostname(&self) -> String;
}

/// `PRETTY_HOSTNAME` from machine-info: an environment-style file whose values may be quoted as
/// a shell would ("…" with backslash escapes, or '…') (`computer-name.ts:34`–`:47`).
pub fn pretty_hostname(machine_info: &str) -> Option<String> {
    for line in machine_info.split('\n') {
        let Some((key, rest)) = line.split_once('=') else {
            continue;
        };
        if key.trim_start() != "PRETTY_HOSTNAME" {
            continue;
        }
        let mut value = rest.trim().to_owned();
        if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
            let inner = &value[1..value.len() - 1];
            value = unescape(inner);
        } else if value.len() >= 2 && value.starts_with('\'') && value.ends_with('\'') {
            value = value[1..value.len() - 1].to_owned();
        }
        let value = value.trim().to_owned();
        return (!value.is_empty()).then_some(value);
    }
    None
}

/// `\\(.)` → `$1`: a doubled quote or a backslash loses its backslash.
fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut characters = text.chars();
    while let Some(character) = characters.next() {
        if character == '\\' {
            if let Some(next) = characters.next() {
                out.push(next);
            } else {
                out.push(character);
            }
        } else {
            out.push(character);
        }
    }
    out
}

/// Read the OS name once per server, with a plain fallback (`computer-name.ts:50`–`:61`).
pub fn computer_name(host: &dyn NameHost) -> String {
    let named = match host.platform() {
        "darwin" => host.mac_name(),
        "linux" => host.machine_info().as_deref().and_then(pretty_hostname),
        _ => None,
    };
    if let Some(named) = named.filter(|name| name.chars().count() <= 256) {
        return named;
    }
    let hostname = host.hostname();
    let cleaned = strip_local_suffix(&hostname).replace('-', " ");
    if cleaned.is_empty() {
        "This machine".to_owned()
    } else {
        cleaned
    }
}

/// `/\.local$/i`, without a regex crate.
fn strip_local_suffix(hostname: &str) -> String {
    let lower = hostname.to_ascii_lowercase();
    if lower.ends_with(".local") {
        hostname[..hostname.len() - ".local".len()].to_owned()
    } else {
        hostname.to_owned()
    }
}

#[cfg(test)]
mod tests {
    //! Ports `apps/daemon/src/computer-name.test.ts`.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::{NameHost, computer_name, pretty_hostname};

    struct Linux {
        machine_info: Option<String>,
        name: String,
    }

    impl NameHost for Linux {
        fn platform(&self) -> &str {
            "linux"
        }

        fn mac_name(&self) -> Option<String> {
            None
        }

        fn machine_info(&self) -> Option<String> {
            self.machine_info.clone()
        }

        fn hostname(&self) -> String {
            self.name.clone()
        }
    }

    fn linux(machine_info: Option<&str>, name: &str) -> Linux {
        Linux {
            machine_info: machine_info.map(str::to_owned),
            name: name.to_owned(),
        }
    }

    #[test]
    fn a_linux_computer_is_called_by_the_name_the_person_gave_it_in_settings() {
        assert_eq!(
            computer_name(&linux(
                Some("PRETTY_HOSTNAME=\"Arpan's \\\"Work\\\" Laptop\"\nCHASSIS=laptop\n"),
                "ubuntu-desktop"
            )),
            "Arpan's \"Work\" Laptop"
        );
        assert_eq!(
            computer_name(&linux(
                Some("CHASSIS=vm\nPRETTY_HOSTNAME='Studio PC'\n"),
                "ubuntu-desktop"
            )),
            "Studio PC"
        );
    }

    #[test]
    fn without_a_given_name_a_linux_computer_is_called_by_its_hostname() {
        assert_eq!(
            computer_name(&linux(None, "ubuntu-desktop")),
            "ubuntu desktop"
        );
        assert_eq!(
            computer_name(&linux(Some("PRETTY_HOSTNAME=\"\"\n"), "ubuntu-desktop")),
            "ubuntu desktop"
        );
        assert_eq!(computer_name(&linux(None, "")), "This machine");
    }

    #[test]
    fn a_mac_is_called_by_its_computer_name() {
        struct Mac;
        impl NameHost for Mac {
            fn platform(&self) -> &str {
                "darwin"
            }
            fn mac_name(&self) -> Option<String> {
                Some("Arpan’s MacBook Pro".to_owned())
            }
            fn machine_info(&self) -> Option<String> {
                None
            }
            fn hostname(&self) -> String {
                "mac".to_owned()
            }
        }
        assert_eq!(computer_name(&Mac), "Arpan’s MacBook Pro");
    }

    #[test]
    fn a_hostname_loses_its_local_suffix_and_its_dashes() {
        assert_eq!(computer_name(&linux(None, "studio.local")), "studio");
        assert_eq!(
            computer_name(&linux(None, "work-laptop.Local")),
            "work laptop"
        );
        assert_eq!(
            pretty_hostname("PRETTY_HOSTNAME=\"back\\\\slash\"\n").as_deref(),
            Some("back\\slash")
        );
    }
}
