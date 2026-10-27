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
    /// The fixture's benchmark window (2,200 items), or the paired app's 200 with `--spike-items 200`.
    static var itemLimit: Int {
        let arguments = ProcessInfo.processInfo.arguments
        return arguments.firstIndex(of: "--spike-items").flatMap { arguments.indices.contains($0 + 1) ? Int(arguments[$0 + 1]) : nil }
            .map { min(max($0, 50), 2200) } ?? 2200
    }
    /// `--spike-view-only`: the phone may only view the fixture machine, as a view-only pairing.
    static var viewOnly: Bool { ProcessInfo.processInfo.arguments.contains("--spike-view-only") }
    /// The thread `--spike-open ID` asks to open at launch.
    static var openOnLaunch: String? {
        let arguments = ProcessInfo.processInfo.arguments
        return arguments.firstIndex(of: "--spike-open").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
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
        guard enabled else { return [] }
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
