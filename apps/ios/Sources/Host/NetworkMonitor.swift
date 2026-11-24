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
    private var wasInterface: MachineRoutePlan.Interface?

    /// `changed`: reachability or interfaces moved. `roomy`: whether the path is online, unmetered
    /// and not in Low Data Mode, from the first reading and on every change (ADR 0128).
    /// `interface`: Wi-Fi or wired Ethernet (the only time a machine moves from its relay to its
    /// direct address), another interface, or unknown while the path has no network; from the
    /// first reading and on every change.
    func start(_ changed: @escaping @Sendable (Change) -> Void, roomy: @escaping @Sendable (Bool) -> Void = { _ in },
               interface: @escaping @Sendable (MachineRoutePlan.Interface) -> Void = { _ in }) {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let online = path.status == .satisfied
            let isRoomy = online && !path.isExpensive && !path.isConstrained
            if self.wasRoomy != isRoomy { self.wasRoomy = isRoomy; roomy(isRoomy) }
            let reading = MachineRoutePlan.Interface(satisfied: online, wifiOrWired: path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet))
            if self.wasInterface != reading { self.wasInterface = reading; interface(reading) }
            let interfaces = path.availableInterfaces.map(\.name)
            defer { self.previous = (online, interfaces) }
            if let change = Self.change(from: self.previous, online: online, interfaces: interfaces) { changed(change) }
        }
        monitor.start(queue: queue)
    }
    func stop() { monitor.cancel() }

    /// What a reading tells `changed`. The first reading is a baseline, not a change, when the path
    /// is satisfied; a first reading with no network is offline news, so the 4s offline hold
    /// (`OfflineHold`) starts for a phone that launches without one.
    static func change(from previous: (online: Bool, interfaces: [String])?, online: Bool, interfaces: [String]) -> Change? {
        guard let previous else { return online ? nil : Change(online: false, interfaceChanged: false) }
        guard previous.online != online || previous.interfaces != interfaces else { return nil }
        return Change(online: online, interfaceChanged: previous.interfaces != interfaces)
    }
}
