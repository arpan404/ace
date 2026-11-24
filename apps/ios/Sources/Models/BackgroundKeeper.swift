import Combine
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
    private var observers: [AnyCancellable] = []

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

    /// Follows UIKit's lifecycle notifications on `center`, not SwiftUI's scene phase (see
    /// `BackgroundHold`). Each is handled as it is posted, on the main thread that posts it.
    func observe(_ center: NotificationCenter) {
        observers = [
            center.publisher(for: UIApplication.willResignActiveNotification)
                .sink { [weak self] _ in MainActor.assumeIsolated { self?.resignActive() } },
            center.publisher(for: UIApplication.didEnterBackgroundNotification)
                .sink { [weak self] _ in MainActor.assumeIsolated { self?.enteredBackground() } },
            center.publisher(for: UIApplication.didBecomeActiveNotification)
                .sink { [weak self] _ in MainActor.assumeIsolated { self?.becameActive() } },
        ]
    }
    private func resignActive() { run(hold.resignActive(connections: connections())) }
    private func enteredBackground() { run(hold.enteredBackground()) }
    private func becameActive() { run(hold.becameActive()) }
    /// A machine's connection state changed (`MachinesModel.onConnectionChange`).
    func connectionsChanged() { run(hold.connectionsChanged(connections())) }
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
