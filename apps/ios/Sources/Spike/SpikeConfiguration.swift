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
    /// `--spike` connects to the fixture on 9841. `--spike-machines 9841,9842` adds one fixture
    /// machine per port (`ACE_SPIKE_PORT=9842 bun run spike:daemon`), each on its own runtime.
    static func targets() -> [(name: String, target: ConnectionTarget)] {
        guard enabled else { return [] }
        let arguments = ProcessInfo.processInfo.arguments
        let ports = arguments.firstIndex(of: "--spike-machines").flatMap { index in
            index + 1 < arguments.count ? arguments[index + 1].split(separator: ",").compactMap { Int($0) } : nil
        } ?? [9841]
        return ports.compactMap { port in
            guard let url = URL(string: "ws://127.0.0.1:\(port)") else { return nil }
            let suffix = port == 9841 ? "" : "-\(port)"
            return (port == 9841 ? "arpan-mbp" : "studio-\(port)",
                    ConnectionTarget(endpoint: url, hostId: "ios-spike-host\(suffix)", deviceId: "ios-spike-device", pin: nil,
                                     credential: { "{\"token\":\"ios-spike-token\"}" }))
        }
    }
}
