import SwiftUI
import QuartzCore

@main struct AceApp: App {
    @UIApplicationDelegateAdaptor(NotificationAppDelegate.self) private var notificationDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = ClientModel(now: { Date().timeIntervalSince1970 * 1000 })
    @State private var started = false
    var body: some Scene {
        WindowGroup {
            Group {
                if started { InboxView(model: model) }
                else {
                    ContentUnavailableView("Your agents, with you", systemImage: "point.3.connected.trianglepath.dotted",
                                           description: Text("Connect to your own machine. Native pairing arrives in the MVP."))
                }
            }
            .environment(notificationDelegate.coordinator)
            .onChange(of: scenePhase) { _, phase in notificationDelegate.coordinator.scene(active: phase == .active) }
            .task {
                guard !started, let target = SpikeConfiguration.target() else { return }
                do {
                    let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                        .appendingPathComponent("ace", isDirectory: true)
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
}
