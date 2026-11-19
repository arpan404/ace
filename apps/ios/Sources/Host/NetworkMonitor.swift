import Foundation
import Network

/// Reports reachability and interface changes (Wi-Fi to cellular, a VPN such as Tailscale
/// coming up). The SDK owns reconnect and backoff; this only tells it what the OS observed.
final class NetworkMonitor: @unchecked Sendable {
    struct Change: Sendable, Equatable { let online: Bool; let interfaceChanged: Bool }
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "ace.network.monitor", qos: .utility)
    private var previous: (online: Bool, interfaces: [String])?
    private var wasRoomy: Bool?

    /// `changed`: reachability or interfaces moved. `roomy`: whether the path is online, unmetered
    /// and not in Low Data Mode, from the first reading and on every change (ADR 0128).
    func start(_ changed: @escaping @Sendable (Change) -> Void, roomy: @escaping @Sendable (Bool) -> Void = { _ in }) {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let online = path.status == .satisfied
            let isRoomy = online && !path.isExpensive && !path.isConstrained
            if self.wasRoomy != isRoomy { self.wasRoomy = isRoomy; roomy(isRoomy) }
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
