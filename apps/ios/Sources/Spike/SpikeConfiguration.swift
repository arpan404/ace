import Foundation

/// Explicit debug launch arguments only. A release never silently connects to a sample machine.
enum SpikeConfiguration {
    static var enabled: Bool {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("--spike")
        #else
        false
        #endif
    }
    static func target() -> ConnectionTarget? {
        // `--spike-port N` lets parallel fixtures share one Mac; loopback only.
        let arguments = ProcessInfo.processInfo.arguments
        let port = arguments.firstIndex(of: "--spike-port").flatMap { arguments.indices.contains($0 + 1) ? Int(arguments[$0 + 1]) : nil } ?? 9841
        guard enabled, (1024...65535).contains(port), let url = URL(string: "ws://127.0.0.1:\(port)") else { return nil }
        return ConnectionTarget(endpoint: url, hostId: "ios-spike-host", deviceId: "ios-spike-device", pin: nil,
                                credential: { "{\"token\":\"ios-spike-token\"}" })
    }
}
