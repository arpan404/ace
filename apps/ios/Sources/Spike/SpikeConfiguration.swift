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
        guard enabled, let url = URL(string: "ws://127.0.0.1:9841") else { return nil }
        return ConnectionTarget(endpoint: url, hostId: "ios-spike-host", deviceId: "ios-spike-device", pin: nil,
                                credential: { "{\"token\":\"ios-spike-token\"}" })
    }
}
