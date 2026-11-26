// SPDX-License-Identifier: Apache-2.0
//! The close codes authentication ends a socket with, word for word from behaviour.md §5 and
//! the protocol's close schemas: a refused hello (`4001`), a replaced credential (`4001`,
//! "Credential replaced"), a revoked device (`4003`, "Device revoked"), an account grant that ran
//! out (`4014`) and an account whose access changed (`4012`). T2 names them so the Rust daemon's
//! socket and relay paths share one source with `@ace/protocol`'s `relay-channel.ts`.

/// Every hello refusal closes with this code (`server.ts:481`, `:866`, `:1019`).
pub const HELLO_REFUSED_CLOSE: u16 = 4001;
/// The reason every hello refusal closes with (`socket.close(4001, code)` where the code is
/// `unauthorized`).
pub const HELLO_REFUSED_REASON: &str = "unauthorized";

/// A paired device's sockets when the same install pairs again (`CredentialReplacedClose`).
pub const CREDENTIAL_REPLACED_CLOSE: u16 = 4001;
pub const CREDENTIAL_REPLACED_REASON: &str = "Credential replaced";

/// A paired device's sockets when the person revokes it (`DeviceRevokedClose`): the only close
/// that lets a client delete what it read from the machine.
pub const DEVICE_REVOKED_CLOSE: u16 = 4003;
pub const DEVICE_REVOKED_REASON: &str = "Device revoked";

/// An account socket whose grant ran out (`grant-lease.ts:8`–`:10`).
pub const GRANT_EXPIRED_CLOSE: u16 = 4014;
pub const GRANT_EXPIRED_REASON: &str = "Account grant expired";

/// An account socket whose access changed: signed out, another account, a new machine code.
pub const ACCESS_CHANGED_CLOSE: u16 = 4012;
pub const ACCESS_CHANGED_REASON: &str = "Account access changed";

/// Finishing a hello failed inside the daemon (a settings, store or service failure):
/// `socket.close(1011, "service_unavailable")` (`server.ts:942`).
pub const SERVICE_UNAVAILABLE_CLOSE: u16 = 1011;
pub const SERVICE_UNAVAILABLE_REASON: &str = "service_unavailable";
