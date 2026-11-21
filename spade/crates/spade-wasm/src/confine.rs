//! Whether this worker runs inside the sandbox Spade starts it in (ADR 0203 §3): the second wall
//! is checked before the first is relied on. Spade starts the worker offline, so a connection to
//! this machine is refused by the sandbox (a permission error), not by the port (connection
//! refused). A worker started any other way, such as `spade --code-worker` run by hand, compiles
//! nothing.

use std::io::ErrorKind;
use std::net::{SocketAddr, TcpStream};
use std::sync::OnceLock;
use std::time::Duration;

/// Why this worker refuses to compile anything here.
pub const NOT_CONFINED: &str =
    "this worker isn't inside the sandbox Spade starts it in, so it compiles nothing";

/// `Ok` when the process can't reach the network, as only Spade's offline sandbox leaves it.
/// Read once; the answer never changes for the process.
pub fn confined() -> Result<(), String> {
    static READ: OnceLock<bool> = OnceLock::new();
    let held = *READ.get_or_init(|| {
        let address = SocketAddr::from(([127, 0, 0, 1], 9));
        match TcpStream::connect_timeout(&address, Duration::from_millis(500)) {
            Ok(_) => false,
            Err(error) => matches!(error.kind(), ErrorKind::PermissionDenied),
        }
    });
    if held {
        Ok(())
    } else {
        Err(NOT_CONFINED.to_owned())
    }
}
