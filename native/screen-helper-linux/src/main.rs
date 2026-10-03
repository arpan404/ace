#[cfg(target_os = "linux")]
#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(error) = ace_screen_helper_linux::runtime::run().await {
        eprintln!("screen-helper: {error}");
        std::process::exit(1);
    }
}
#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("ace-screen-helper-linux requires Linux; use cargo test for portable modules");
    std::process::exit(1);
}
