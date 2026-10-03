fn main() {
    println!("cargo:rerun-if-changed=src/pipewire.c");
    let target = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let host = std::env::var("HOST").unwrap_or_default();
    // macOS can typecheck Linux Rust code without a C sysroot. Release builds run in Linux.
    if target == "linux" && host.contains("linux") {
        cc::Build::new()
            .file("src/pipewire.c")
            .include("/usr/include/pipewire-0.3")
            .include("/usr/include/spa-0.2")
            .flag("-std=gnu11")
            .compile("ace_pipewire");
        println!("cargo:rustc-link-lib=dl");
    }
}
