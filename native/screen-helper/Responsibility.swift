import Foundation
import Darwin

/// macOS attributes privacy (TCC) checks to the "responsible" process: by default the app that
/// launched us, through the daemon. The desktop app's local builds are ad-hoc signed, so every
/// rebuild changes its identity and silently voids its Screen Recording and Accessibility grants.
/// The helper re-executes itself once with responsibility disclaimed, so macOS asks about and
/// remembers "Ace Screen Helper" (stable `dev.ace.screen-helper` identity) instead.
///
/// The re-executed child shares stdin, stdout, stderr and the process group, so the daemon's
/// group supervision and stdin EOF still end it. The parent only waits and mirrors its exit.
enum Responsibility {
    static let marker = "ACE_SCREEN_HELPER_RESPONSIBLE"

    /// Returns when this process should run the helper; otherwise exits with the child's status.
    static func disclaimIfNeeded() {
        if getenv(marker) != nil { return }
        if CommandLine.arguments.contains("--inherit-responsibility") { return }
        typealias Disclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
        // Exported by libsystem (macOS 10.14+) but not declared in the SDK; resolved at runtime
        // so a system without it keeps the old attribution instead of failing to launch.
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") else {
            FileHandle.standardError.write(Data("screen-helper: cannot disclaim responsibility; permissions follow the launching app\n".utf8))
            return
        }
        let disclaim = unsafeBitCast(symbol, to: Disclaim.self)
        var attributes: posix_spawnattr_t?
        guard posix_spawnattr_init(&attributes) == 0 else { return }
        defer { posix_spawnattr_destroy(&attributes) }
        guard disclaim(&attributes, 1) == 0 else { return }
        setenv(marker, "1", 1)
        let path = Bundle.main.executablePath ?? CommandLine.arguments[0]
        let argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
        defer { argv.forEach { free($0) } }
        var child: pid_t = 0
        let status = posix_spawn(&child, path, nil, &attributes, argv, environ)
        guard status == 0 else {
            unsetenv(marker)
            FileHandle.standardError.write(Data("screen-helper: re-exec failed (\(status)); permissions follow the launching app\n".utf8))
            return
        }
        for signalNumber in [SIGTERM, SIGINT, SIGHUP] {
            signal(signalNumber) { received in
                if let child = Responsibility.child { kill(child, received) }
            }
        }
        Responsibility.child = child
        var exitStatus: Int32 = 0
        while waitpid(child, &exitStatus, 0) == -1 && errno == EINTR {}
        // Mirror the child's outcome: its exit code, or 128 + the signal that ended it.
        if exitStatus & 0x7f == 0 { exit((exitStatus >> 8) & 0xff) }
        exit(128 + (exitStatus & 0x7f))
    }

    nonisolated(unsafe) static var child: pid_t?
}
