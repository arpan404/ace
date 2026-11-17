import Foundation

/// Explicit debug launch arguments only. A release never silently connects to a sample machine.
enum SpikeConfiguration {
    static var renderFixtureEnabled: Bool {
        #if ACE_FIXTURE
        ProcessInfo.processInfo.arguments.contains("--chat-render-fixture")
        #else
        false
        #endif
    }
    static var enabled: Bool {
        #if ACE_FIXTURE
        ProcessInfo.processInfo.arguments.contains("--spike")
        #else
        false
        #endif
    }
    /// `--spike-late-machines`: the inbox shows from the first frame and its machines attach a few
    /// seconds later, as a production cold start reads its paired machines after launch.
    static var lateMachines: Bool { enabled && ProcessInfo.processInfo.arguments.contains("--spike-late-machines") }
    /// The fixture's benchmark window (2,200 items), or the paired app's 200 with `--spike-items 200`.
    static var itemLimit: Int {
        let arguments = ProcessInfo.processInfo.arguments
        return arguments.firstIndex(of: "--spike-items").flatMap { arguments.indices.contains($0 + 1) ? Int(arguments[$0 + 1]) : nil }
            .map { min(max($0, 50), 2200) } ?? 2200
    }
    /// `--spike-read-ahead`: read likely threads ahead, as on Wi-Fi outside Low Power Mode.
    static var readAhead: Bool { enabled && ProcessInfo.processInfo.arguments.contains("--spike-read-ahead") }
    /// `--spike-unpaired`: a fresh install with no computer paired, connecting to no fixture, so
    /// home and Code review offer pairing.
    static var unpaired: Bool { enabled && ProcessInfo.processInfo.arguments.contains("--spike-unpaired") }
    /// `--spike-account`: Profile shows a signed-in ace account and its machines, with no
    /// backend, so the signed-in page can be checked and screenshotted.
    static var account: Bool { enabled && ProcessInfo.processInfo.arguments.contains("--spike-account") }
    /// The account machines `--spike-account` lists, last seen a few minutes and days before `now`.
    static func accountMachines(now: Double) -> [AceMachine] {
        [AceMachine(hostId: "ios-spike-host", name: "arpan-mbp", platform: "darwin", lastSeenAt: now - 4 * 60_000),
         AceMachine(hostId: "fixture-studio", name: "studio", platform: "linux", lastSeenAt: now - 3 * 86_400_000)]
    }
    /// `--spike-view-only`: the phone may only view the fixture machine, as a view-only pairing.
    static var viewOnly: Bool { ProcessInfo.processInfo.arguments.contains("--spike-view-only") }
    /// The thread `--spike-open ID` asks to open at launch.
    static var openOnLaunch: String? {
        let arguments = ProcessInfo.processInfo.arguments
        return arguments.firstIndex(of: "--spike-open").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
    }
    /// The `ace://` link `--spike-link URL` opens at launch, as one opened from another app would,
    /// without the system's "Open in ace?" prompt `simctl openurl` raises (screenshots, tests).
    static var linkOnLaunch: URL? {
        guard enabled else { return nil }
        let arguments = ProcessInfo.processInfo.arguments
        return arguments.firstIndex(of: "--spike-link").flatMap { arguments.indices.contains($0 + 1) ? URL(string: arguments[$0 + 1]) : nil }
    }
    /// The item `--spike-focus ID` asks the opened thread to show, as a search hit does.
    static var focusOnLaunch: String? {
        let arguments = ProcessInfo.processInfo.arguments
        return arguments.firstIndex(of: "--spike-focus").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
    }
    static func target() -> ConnectionTarget? {
        // `--spike-port N` lets parallel fixtures share one Mac; loopback only.
        let arguments = ProcessInfo.processInfo.arguments
        let port = arguments.firstIndex(of: "--spike-port").flatMap { arguments.indices.contains($0 + 1) ? Int(arguments[$0 + 1]) : nil } ?? 9841
        guard enabled, (1024...65535).contains(port), let url = URL(string: "ws://127.0.0.1:\(port)") else { return nil }
        return ConnectionTarget(endpoint: url, hostId: "ios-spike-host", deviceId: "ios-spike-device", pin: nil,
                                credential: { "{\"token\":\"ios-spike-token\"}" })
    }
    /// The fixture machines to run at once. `--spike-machines 9852,9863` connects one runtime per
    /// port to fixtures started with `ACE_IOS_SPIKE_PORT=<port> ACE_IOS_SPIKE_MACHINE=1`, each its
    /// own host; otherwise the single `target()`.
    static func targets() -> [(name: String, target: ConnectionTarget)] {
        guard enabled, !unpaired else { return [] }
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "--spike-machines"), arguments.indices.contains(index + 1) else {
            return target().map { [("arpan-mbp", $0)] } ?? []
        }
        return arguments[index + 1].split(separator: ",").compactMap { Int($0) }.filter { (1024...65535).contains($0) }.compactMap { port in
            guard let url = URL(string: "ws://127.0.0.1:\(port)") else { return nil }
            return ("studio-\(port)", ConnectionTarget(endpoint: url, hostId: "ios-spike-host-\(port)", deviceId: "ios-spike-device", pin: nil,
                                                       credential: { "{\"token\":\"ios-spike-token\"}" }))
        }
    }
    /// Spike launches start without unsent thread words or a thread to reopen, so one UI test's
    /// state never reaches the next; `--spike-keep-state` keeps both, for the relaunch checks.
    static func threadDrafts(in directory: URL, defaults: UserDefaults = .standard) -> URL {
        let url = directory.appendingPathComponent("spike-thread-drafts.json")
        if !ProcessInfo.processInfo.arguments.contains("--spike-keep-state") {
            try? FileManager.default.removeItem(at: url)
            defaults.removeObject(forKey: "ace.inbox.openThread")
        }
        return url
    }
}

/// `--spike-unpaired`'s own storage and defaults, emptied once per launch before anything reads
/// them: its machines, drafts and notification settings never touch the app's real ones.
/// Settings changed inside this mode (views' own `@AppStorage`) still use the app's standard defaults.
enum UnpairedScratch {
    static let suite = "app.ace.spike.unpaired"
    static let root: URL = {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ace-spike-unpaired", isDirectory: true)
        try? FileManager.default.removeItem(at: root)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        UserDefaults.standard.removePersistentDomain(forName: suite)
        return root
    }()
    /// The suite, emptied with `root` before its first read.
    static var defaults: UserDefaults {
        _ = root
        guard let defaults = UserDefaults(suiteName: suite) else { preconditionFailure("UserDefaults refused the suite \(suite)") }
        return defaults
    }
}
