import Foundation
import Network

/// Reports reachability and interface changes (Wi-Fi to cellular, a VPN such as Tailscale
/// coming up). The SDK owns reconnect and backoff; this only tells it what the OS observed.
final class NetworkMonitor: @unchecked Sendable {
    struct Change: Sendable, Equatable { let online: Bool; let interfaceChanged: Bool }
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "ace.network.monitor", qos: .utility)
    private var previous: (online: Bool, interfaces: [String])?

    func start(_ changed: @escaping @Sendable (Change) -> Void) {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let online = path.status == .satisfied
            let interfaces = path.availableInterfaces.map(\.name)
            defer { self.previous = (online, interfaces) }
            guard let previous = self.previous else { return }
            guard previous.online != online || previous.interfaces != interfaces else { return }
            changed(Change(online: online, interfaceChanged: previous.interfaces != interfaces))
        }
        monitor.start(queue: queue)
    }
    func stop() { monitor.cancel() }
}
