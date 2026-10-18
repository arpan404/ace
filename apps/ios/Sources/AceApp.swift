import SwiftUI
import QuartzCore

@main struct AceApp: App {
    @State private var spikeInbox = MachineInbox(now: { Date().timeIntervalSince1970 * 1000 })
    @State private var started = false
    @State private var production = ProductionApp.make()
    var body: some Scene {
        WindowGroup {
            if SpikeConfiguration.enabled { spike } else if let production { production.root() } else { storageUnavailable }
        }
    }
    private var storageUnavailable: some View {
        ContentUnavailableView("Storage unavailable", systemImage: "externaldrive.badge.exclamationmark",
                               description: Text("ace couldn't open its storage on this phone."))
    }
    /// Debug `--spike` only: the loopback fixture with a fixed fake device credential.
    private var spike: some View {
        Group {
            if started { InboxView(inbox: spikeInbox) }
            else { ContentUnavailableView("Connecting to the spike daemon", systemImage: "point.3.connected.trianglepath.dotted") }
        }
        .task {
            let targets = SpikeConfiguration.targets()
            guard !started, !targets.isEmpty, let directory = try? ProductionApp.storageDirectory() else { return }
            // One runtime per fixture machine, as production runs one per paired computer.
            for (index, spike) in targets.enumerated() {
                let model = ClientModel(now: { Date().timeIntervalSince1970 * 1000 })
                spikeInbox.attach(spike.target.hostId, name: spike.name, client: model)
                await model.connect(target: spike.target, directory: directory, itemLimit: 2200)
                #if DEBUG
                if index == 0 {
                    let metrics = SpikeMetrics(model: model, now: { CACurrentMediaTime() }, output: directory.appendingPathComponent("spike-metrics.json"))
                    model.metrics = metrics
                    metrics.start()
                }
                #endif
            }
            started = true
        }
    }
}

/// Paired machines, app lock and network observation for real daemons.
@MainActor final class ProductionApp {
    let directory: URL
    let lock: AppLock
    private var machines: MachinesModel?
    private let network = NetworkMonitor()

    private init(directory: URL) {
        self.directory = directory
        let paired = FileManager.default.fileExists(atPath: Self.machineDirectory(in: directory).path)
        lock = AppLock(enabled: paired, now: { Date() })
    }
    static func make() -> ProductionApp? {
        guard !SpikeConfiguration.enabled, let directory = try? storageDirectory() else { return nil }
        return ProductionApp(directory: directory)
    }
    nonisolated static func storageDirectory() throws -> URL {
        try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("ace", isDirectory: true)
    }
    nonisolated static func machineDirectory(in directory: URL) -> URL { directory.appendingPathComponent("machines.json") }

    func root() -> some View {
        let machines = self.machines ?? MachinesModel(access: BridgeMachineAccess(directoryURL: Self.machineDirectory(in: directory)),
                                                      storage: directory.appendingPathComponent("machines", isDirectory: true),
                                                      makeClient: { ClientModel(now: { Date().timeIntervalSince1970 * 1000 }) })
        if self.machines == nil {
            self.machines = machines
            network.start { change in
                Task { @MainActor in machines.network(online: change.online, interfaceChanged: change.interfaceChanged) }
            }
        }
        return RootView(machines: machines, lock: lock)
    }
}
