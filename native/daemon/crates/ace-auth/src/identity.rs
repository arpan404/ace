// SPDX-License-Identifier: Apache-2.0
//! The `host.identity` answer (`apps/daemon/src/services/host-identity.ts`) and the OS name
//! behind it (`computer-name.ts`): a bounded settings read (the display name and the icon), the
//! platform filter clients understand, the read-scope check, the busy flag a second request sees
//! while the first is still reading, and the name a Linux or Mac computer was given.

use std::sync::Mutex;

pub mod computer;

pub use computer::{NameHost, computer_name, pretty_hostname};

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

#[cfg(test)]
mod tests;
