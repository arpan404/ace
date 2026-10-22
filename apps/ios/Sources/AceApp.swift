import SwiftUI
import QuartzCore

@main struct AceApp: App {
    @UIApplicationDelegateAdaptor(NotificationAppDelegate.self) private var notificationDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var spikeInbox = MachineInbox(now: { Date().timeIntervalSince1970 * 1000 })
    @State private var started = false
    @State private var production = ProductionApp.make()
    var body: some Scene {
        WindowGroup {
            Group {
                if SpikeConfiguration.renderFixtureEnabled { renderFixture }
                else if SpikeConfiguration.enabled { spike }
                else if let production {
                    production.root(notifications: notificationDelegate.coordinator)
                        .environment(notificationDelegate.coordinator)
                        .onChange(of: scenePhase) { _, phase in notificationDelegate.coordinator.scene(active: phase == .active) }
                } else { storageUnavailable }
            }.modifier(PhoneAppearance())
        }
    }
    @ViewBuilder private var renderFixture: some View {
        #if DEBUG
        ChatRenderFixture()
        #else
        EmptyView()
        #endif
    }
    private var storageUnavailable: some View {
        EmptyState(icon: nil, title: "Storage unavailable", line: "ace couldn't open its storage on this phone.", failed: true)
            .frame(maxHeight: .infinity)
    }
    /// Debug `--spike` only: the loopback fixture with a fixed fake device credential.
    private var spike: some View {
        Group {
            if started { InboxView(inbox: spikeInbox) }
            else { EmptyState(icon: .graph, title: "Connecting to the spike daemon").frame(maxHeight: .infinity) }
        }
        .environment(notificationDelegate.coordinator)
        .onChange(of: scenePhase) { _, phase in notificationDelegate.coordinator.scene(active: phase == .active) }
        .task {
            let targets = SpikeConfiguration.targets()
            guard !started, !targets.isEmpty, let directory = try? ProductionApp.storageDirectory() else { return }
            // One runtime per fixture machine, as production runs one per paired computer.
            for (index, spike) in targets.enumerated() {
                let model = ClientModel(now: { Date().timeIntervalSince1970 * 1000 })
                spikeInbox.attach(spike.target.hostId, name: spike.name, client: model)
                await notificationDelegate.coordinator.attach(model, target: spike.target)
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
    /// Each remembered machine's runtime evaluates the client bundle from the first moment.
    private let warmup = RuntimeWarmup()
    private let network = NetworkMonitor()

    private init(directory: URL) {
        self.directory = directory
        let paired = FileManager.default.fileExists(atPath: Self.machineDirectory(in: directory).path)
        lock = AppLock(enabled: paired, now: { Date() }, defaults: .standard)
        warmup.prepare(MachinesModel.rememberedCount(in: .standard))
    }
    static func make() -> ProductionApp? {
        guard !SpikeConfiguration.enabled, let directory = try? storageDirectory() else { return nil }
        LaunchTrace.mark("app.init")
        return ProductionApp(directory: directory)
    }
    nonisolated static func storageDirectory() throws -> URL {
        try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("ace", isDirectory: true)
    }
    nonisolated static func machineDirectory(in directory: URL) -> URL { directory.appendingPathComponent("machines.json") }

    /// Every paired machine, each runtime bound to notifications before it connects and released
    /// when the machine is removed. Background launches build their own.
    static func machines(directory: URL, notifications: NotificationCoordinator, warmup: RuntimeWarmup? = nil,
                         now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }) -> MachinesModel {
        let machines = MachinesModel(access: BridgeMachineAccess(directoryURL: machineDirectory(in: directory)),
                                     storage: directory.appendingPathComponent("machines", isDirectory: true), now: now,
                                     makeClient: { warmup.map { ClientModel(now: now, makeRuntime: $0.makeRuntime) } ?? ClientModel(now: now) })
        machines.afterLoad = { warmup?.releaseUnused() }
        machines.beforeConnect = { [weak notifications] model, target in await notifications?.attach(model, target: target) }
        machines.afterRemove = { [weak notifications] model, _ in notifications?.detach(model) }
        return machines
    }

    func root(notifications: NotificationCoordinator) -> some View {
        let machines = self.machines ?? Self.machines(directory: directory, notifications: notifications, warmup: warmup)
        if self.machines == nil {
            self.machines = machines
            network.start { change in
                Task { @MainActor in machines.network(online: change.online, interfaceChanged: change.interfaceChanged) }
            }
        }
        return RootView(machines: machines, lock: lock)
    }
}
