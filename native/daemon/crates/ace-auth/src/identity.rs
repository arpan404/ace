// SPDX-License-Identifier: Apache-2.0
//! The `host.identity` answer (`apps/daemon/src/services/host-identity.ts`) and the OS name
//! behind it (`computer-name.ts`): a bounded settings read (the display name and the icon), the
//! platform filter clients understand, the read-scope check, the busy flag a second request sees
//! while the first is still reading, and the name a Linux or Mac computer was given.

use std::sync::Mutex;

/// The curated machine marks clients draw (`MachineIconKind`, `host-identity.ts:7`–`:16`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MachineIconKind {
    Laptop,
    Desktop,
    Monitor,
    Server,
    Cloud,
    Cpu,
    Terminal,
    Phone,
}

impl MachineIconKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Laptop => "laptop",
            Self::Desktop => "desktop",
            Self::Monitor => "monitor",
            Self::Server => "server",
            Self::Cloud => "cloud",
            Self::Cpu => "cpu",
            Self::Terminal => "terminal",
            Self::Phone => "phone",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "laptop" => Self::Laptop,
            "desktop" => Self::Desktop,
            "monitor" => Self::Monitor,
            "server" => Self::Server,
            "cloud" => Self::Cloud,
            "cpu" => Self::Cpu,
            "terminal" => Self::Terminal,
            "phone" => Self::Phone,
            _ => return None,
        })
    }
}

/// A machine icon's colour (`MachineIcon`, `host-identity.ts:20`–`:24`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum IconColor {
    Default,
    Blue,
    Green,
    Purple,
    Orange,
}

impl IconColor {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Blue => "blue",
            Self::Green => "green",
            Self::Purple => "purple",
            Self::Orange => "orange",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "default" => Self::Default,
            "blue" => Self::Blue,
            "green" => Self::Green,
            "purple" => Self::Purple,
            "orange" => Self::Orange,
            _ => return None,
        })
    }
}

/// One machine mark.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachineIcon {
    pub kind: MachineIconKind,
    pub color: Option<IconColor>,
}

/// A settings value with where it came from (`SettingsService.get`), so the identity can tell a
/// person's icon from the default one (`host-identity.ts:39`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingValue<T> {
    pub value: T,
    /// `"defaults"`: nobody set it, so the client picks its own mark.
    pub provenance: String,
}

impl<T> SettingValue<T> {
    pub fn defaults(value: T) -> Self {
        Self {
            value,
            provenance: "defaults".to_owned(),
        }
    }

    pub fn set(value: T) -> Self {
        Self {
            value,
            provenance: "user".to_owned(),
        }
    }

    fn is_default(&self) -> bool {
        self.provenance == "defaults"
    }
}

/// The identity a client reads, in `HostIdentity`'s key order (`host-identity.ts:31`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostIdentity {
    pub host_id: String,
    pub display_name: String,
    pub icon: Option<MachineIcon>,
    pub hostname: Option<String>,
    pub version: String,
    /// Only the three systems clients know (`HostPlatform`); any other is left out.
    pub platform: Option<String>,
}

/// What the service knows before it reads settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityFacts {
    pub host_id: String,
    /// The injected host name, else the OS name resolved once per server.
    pub default_name: String,
    /// `os.hostname()`, kept for legacy thread metadata.
    pub hostname: String,
    pub version: String,
    /// `options.platform ?? process.platform`, as the runtime names it.
    pub platform: String,
}

/// The platform clients are told about, or `None` for one they don't know.
pub fn known_platform(platform: &str) -> Option<String> {
    match platform {
        "darwin" | "linux" | "win32" => Some(platform.to_owned()),
        _ => None,
    }
}

/// Build the identity: the person's display name if they set one, else the default name; the
/// icon only when someone set it; the host name and version always; the platform when known.
pub fn host_identity(
    facts: &IdentityFacts,
    display_name: Option<&SettingValue<String>>,
    icon: Option<&SettingValue<MachineIcon>>,
) -> HostIdentity {
    let named = display_name
        .map(|setting| setting.value.as_str())
        .filter(|name| !name.is_empty());
    HostIdentity {
        host_id: facts.host_id.clone(),
        display_name: named.unwrap_or(&facts.default_name).to_owned(),
        icon: icon
            .filter(|setting| !setting.is_default())
            .map(|setting| setting.value.clone()),
        hostname: Some(facts.hostname.clone()),
        version: facts.version.clone(),
        platform: known_platform(&facts.platform),
    }
}

/// Why an identity request wasn't answered with the identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityRefusal {
    /// The socket's credential holds no `read` scope (`host-identity.ts:23`–`:27`).
    Forbidden,
    /// The previous read hasn't finished.
    Busy,
    /// The settings read failed.
    Unavailable,
}

impl IdentityRefusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::Forbidden => "forbidden",
            Self::Busy => "busy",
            Self::Unavailable => "unavailable",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::Forbidden | Self::Busy => "Identity read unavailable",
            Self::Unavailable => "Identity read failed",
        }
    }
}

/// One socket's identity reads (`createHostIdentitySession`): one at a time.
#[derive(Debug, Default)]
pub struct IdentitySession {
    pending: Mutex<bool>,
}

impl IdentitySession {
    pub fn new() -> Self {
        Self::default()
    }

    /// Begin a read. `Err` is the refusal to send as it stands; `Ok` means the caller now reads
    /// the settings and must answer with [`IdentitySession::finish`] or
    /// [`IdentitySession::failed`].
    pub fn begin(&self, can_read: bool) -> Result<(), IdentityRefusal> {
        if !can_read {
            return Err(IdentityRefusal::Forbidden);
        }
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if *pending {
            return Err(IdentityRefusal::Busy);
        }
        *pending = true;
        Ok(())
    }

    /// The read finished: the identity if the socket still authorizes, else nothing, as the
    /// TypeScript drops an answer whose socket lost its scope mid-read.
    pub fn finish(&self, can_read: bool, identity: HostIdentity) -> Option<HostIdentity> {
        self.clear();
        can_read.then_some(identity)
    }

    pub fn failed(&self) -> IdentityRefusal {
        self.clear();
        IdentityRefusal::Unavailable
    }

    fn clear(&self) {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *pending = false;
    }
}

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
    //! Ports `apps/daemon/src/host-identity.server.process.test.ts` (all five cases) and
    //! `apps/daemon/src/computer-name.test.ts`.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::{
        IconColor, IdentityFacts, IdentityRefusal, IdentitySession, MachineIcon, MachineIconKind,
        NameHost, SettingValue, computer_name, host_identity, pretty_hostname,
    };

    fn facts() -> IdentityFacts {
        IdentityFacts {
            host_id: "host".to_owned(),
            default_name: "Laptop".to_owned(),
            hostname: "laptop".to_owned(),
            version: "1.2.3".to_owned(),
            platform: "darwin".to_owned(),
        }
    }

    #[test]
    fn authenticated_identity_uses_the_computer_name_until_the_global_display_name_is_edited() {
        let first = host_identity(&facts(), None, None);
        assert_eq!(first.display_name, "Laptop");
        assert_eq!(first.host_id, "host");
        assert_eq!(first.version, "1.2.3");
        assert_eq!(first.platform.as_deref(), Some("darwin"));
        // The person renames it and picks a mark.
        let renamed = SettingValue::set("Office".to_owned());
        let icon = SettingValue::set(MachineIcon {
            kind: MachineIconKind::Server,
            color: Some(IconColor::Purple),
        });
        let renamed_identity = host_identity(&facts(), Some(&renamed), Some(&icon));
        assert_eq!(renamed_identity.display_name, "Office");
        assert_eq!(
            renamed_identity.icon,
            Some(MachineIcon {
                kind: MachineIconKind::Server,
                color: Some(IconColor::Purple),
            })
        );
        // A reconnect reads the same settings, so it sees the same name and mark.
        assert_eq!(
            host_identity(&facts(), Some(&renamed), Some(&icon)),
            renamed_identity
        );
        // An unset icon is left out: the client picks its own default mark.
        let default_icon = SettingValue::defaults(MachineIcon {
            kind: MachineIconKind::Laptop,
            color: None,
        });
        assert_eq!(
            host_identity(&facts(), None, Some(&default_icon)).icon,
            None
        );
        // An empty display name falls back to the computer's own name.
        let empty = SettingValue::set(String::new());
        assert_eq!(
            host_identity(&facts(), Some(&empty), None).display_name,
            "Laptop"
        );
    }

    #[test]
    fn an_unauthenticated_socket_cannot_read_host_identity() {
        // A socket with no hello reaches no service: the hello gate refuses it. What T2 owns is
        // the service's own scope check, which refuses a socket without `read`.
        let session = IdentitySession::new();
        assert_eq!(session.begin(false), Err(IdentityRefusal::Forbidden));
        assert_eq!(IdentityRefusal::Forbidden.code(), "forbidden");
        assert_eq!(
            IdentityRefusal::Forbidden.message(),
            "Identity read unavailable"
        );
    }

    #[test]
    fn identity_requires_read_scope_on_an_authenticated_paired_connection() {
        // An `operate`-only device: the socket is welcomed, the identity read is forbidden.
        assert!(!crate::devices::allows_scopes(
            &[crate::devices::Scope::Operate],
            crate::devices::Scope::Read
        ));
        let session = IdentitySession::new();
        assert_eq!(session.begin(false), Err(IdentityRefusal::Forbidden));
    }

    #[test]
    fn identity_says_which_operating_system_and_leaves_out_one_clients_do_not_know() {
        for (platform, reported) in [
            ("darwin", Some("darwin")),
            ("linux", Some("linux")),
            ("win32", Some("win32")),
            ("aix", None),
        ] {
            let identity = host_identity(
                &IdentityFacts {
                    platform: platform.to_owned(),
                    ..facts()
                },
                None,
                None,
            );
            assert_eq!(identity.platform.as_deref(), reported, "{platform}");
        }
    }

    #[test]
    fn without_an_injected_platform_the_daemon_reports_the_one_it_runs_on() {
        // Node names the running system: `darwin` on macOS, `win32` on Windows.
        let platform = match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            other => other,
        };
        let identity = host_identity(
            &IdentityFacts {
                platform: platform.to_owned(),
                ..facts()
            },
            None,
            None,
        );
        assert_eq!(identity.platform.as_deref(), Some(platform));
    }

    #[test]
    fn a_second_read_while_the_first_is_pending_is_busy_and_the_first_answers() {
        let session = IdentitySession::new();
        session.begin(true).unwrap();
        assert_eq!(session.begin(true), Err(IdentityRefusal::Busy));
        assert_eq!(IdentityRefusal::Busy.code(), "busy");
        let identity = host_identity(&facts(), None, None);
        assert!(session.finish(true, identity.clone()).is_some());
        // A socket that lost its read scope while the settings were read is told nothing.
        session.begin(true).unwrap();
        assert!(session.finish(false, identity.clone()).is_none());
        // And the failure answer, which also clears the flag.
        session.begin(true).unwrap();
        assert_eq!(session.failed(), IdentityRefusal::Unavailable);
        session.begin(true).expect("the flag was cleared");
    }

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
