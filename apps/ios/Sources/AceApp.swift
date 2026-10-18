import SwiftUI
import QuartzCore

@main struct AceApp: App {
    @UIApplicationDelegateAdaptor(NotificationAppDelegate.self) private var notificationDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = ClientModel(now: { Date().timeIntervalSince1970 * 1000 })
    @State private var started = false
    @State private var production = ProductionApp.make()
    var body: some Scene {
        WindowGroup {
            if SpikeConfiguration.enabled { spike }
            else if let production {
                production.root(model: model, notifications: notificationDelegate.coordinator)
                    .environment(notificationDelegate.coordinator)
                    .onChange(of: scenePhase) { _, phase in notificationDelegate.coordinator.scene(active: phase == .active) }
            } else { storageUnavailable }
        }
    }
    private var storageUnavailable: some View {
        ContentUnavailableView("Storage unavailable", systemImage: "externaldrive.badge.exclamationmark",
                               description: Text("ace couldn't open its storage on this phone."))
    }
    /// Debug `--spike` only: the loopback fixture with a fixed fake device credential.
    private var spike: some View {
        Group {
            if started { InboxView(model: model) }
            else { ContentUnavailableView("Connecting to the spike daemon", systemImage: "point.3.connected.trianglepath.dotted") }
        }
        .environment(notificationDelegate.coordinator)
        .onChange(of: scenePhase) { _, phase in notificationDelegate.coordinator.scene(active: phase == .active) }
        .task {
            guard !started, let target = SpikeConfiguration.target() else { return }
            do {
                let directory = try ProductionApp.storageDirectory()
                await notificationDelegate.coordinator.attach(model, target: target)
                await model.connect(target: target, directory: directory, itemLimit: 2200)
                #if DEBUG
                let metrics = SpikeMetrics(model: model, now: { CACurrentMediaTime() }, output: directory.appendingPathComponent("spike-metrics.json"))
                model.metrics = metrics
                metrics.start()
                #endif
                started = true
            } catch { model.error = "Could not open local storage" }
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

    /// The paired directory driving `client`. Background launches build one for their own client.
    static func machines(client: ClientModel, directory: URL, notifications: NotificationCoordinator) -> MachinesModel {
        let machines = MachinesModel(client: client, access: BridgeMachineAccess(directoryURL: machineDirectory(in: directory)),
                                     storage: directory.appendingPathComponent("machines", isDirectory: true))
        machines.beforeConnect = { [weak notifications] model, target in await notifications?.attach(model, target: target) }
        return machines
    }

    func root(model: ClientModel, notifications: NotificationCoordinator) -> some View {
        let machines = self.machines ?? Self.machines(client: model, directory: directory, notifications: notifications)
        if self.machines == nil {
            self.machines = machines
            network.start { change in
                Task { @MainActor in
                    model.network(change.online)
                    // A new interface (Wi-Fi, cellular, Tailscale) can reach a host the old one couldn't.
                    if change.online && change.interfaceChanged { model.retry() }
                }
            }
        }
        return RootView(machines: machines, lock: lock)
    }
}
