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
    /// `--spike-port N` selects another loopback fixture when the default port is taken.
    static var port: Int {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "--spike-port"), index + 1 < arguments.count,
              let value = Int(arguments[index + 1]), (1024...65535).contains(value) else { return 9841 }
        return value
    }
    static func target() -> ConnectionTarget? {
        guard enabled, let url = URL(string: "ws://127.0.0.1:\(port)") else { return nil }
        return ConnectionTarget(endpoint: url, hostId: "ios-spike-host", deviceId: "ios-spike-device", pin: nil,
                                credential: { "{\"token\":\"ios-spike-token\"}" })
    }
}
