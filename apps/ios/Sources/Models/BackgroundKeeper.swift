import Foundation
import UIKit

/// Runs `BackgroundHold`'s effects against iOS's background task API and the machines.
@MainActor final class BackgroundKeeper {
    private var hold: BackgroundHold
    private let connections: () -> [String]
    private let begin: (@escaping @MainActor () -> Void) -> Int
    private let end: (Int) -> Void
    private let wake: () -> Void
    private var task: Int?

    init(enabled: Bool, connections: @escaping () -> [String], begin: @escaping (@escaping @MainActor () -> Void) -> Int,
         end: @escaping (Int) -> Void, wake: @escaping () -> Void) {
        hold = BackgroundHold(enabled: enabled)
        self.connections = connections
        self.begin = begin
        self.end = end
        self.wake = wake
    }

    /// The app's own: UIKit's task assertion and the system's Background App Refresh setting.
    /// `connections` reads each machine's connection state right now.
    static func system(connections: @escaping () -> [String], wake: @escaping () -> Void) -> BackgroundKeeper {
        BackgroundKeeper(
            enabled: UIApplication.shared.backgroundRefreshStatus == .available, connections: connections,
            begin: { expired in
                UIApplication.shared.beginBackgroundTask(withName: "Keep machines connected") {
                    MainActor.assumeIsolated { expired() }
                }.rawValue
            },
            end: { UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: $0)) },
            wake: wake)
    }

    func resignActive() { run(hold.resignActive(connections: connections())) }
    func enteredBackground() { run(hold.enteredBackground()) }
    func becameActive() { run(hold.becameActive()) }
    func refreshSetting(_ on: Bool) { run(hold.setEnabled(on)) }

    private func run(_ effects: [BackgroundHold.Effect]) {
        for effect in effects {
            switch effect {
            case .beginTask: task = begin { [weak self] in self?.expired() }
            case .endTask: if let id = task { task = nil; end(id) }
            case .wake: wake()
            }
        }
    }
    private func expired() { run(hold.expired()) }
}
