//! Links the add-on so Node-API symbols resolve from the host runtime (Bun) at load time.

fn main() {
    napi_build::setup();
}
