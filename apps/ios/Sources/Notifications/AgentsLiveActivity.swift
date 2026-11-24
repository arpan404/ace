import ActivityKit
import Foundation

enum AgentsActivityPlan {
    static let quietGrace: TimeInterval = 120
    static let lingerAfterEnd: TimeInterval = 15 * 60
    static let renewEvery: TimeInterval = 60
}

typealias MachineActivityState = MachineActivityAttributes.ContentState

/// The ActivityKit boundary used by the lock screen hub.
@MainActor protocol AgentsActivityPort: AnyObject {
    var systemAllowed: Bool { get }
    var frequentUpdates: Bool { get }
    var startToken: Data? { get }
    var slots: Set<Int> { get }
    func current(slot: Int) -> (id: String, state: MachineActivityState, token: Data?)?
    func observe(_ changed: @escaping @MainActor () -> Void)
    func start(slot: Int, _ state: MachineActivityState, staleDate: Date) throws
    func update(slot: Int, id: String, _ state: MachineActivityState, staleDate: Date) async
    func end(slot: Int, id: String, _ state: MachineActivityState?, dismissAt: Date?) async
}

@MainActor final class SystemAgentsActivity: AgentsActivityPort {
    private typealias Entry = Activity<MachineActivityAttributes>
    private let authorization = ActivityAuthorizationInfo()
    private var changed: (@MainActor () -> Void)?
    private var observers: [Task<Void, Never>] = []
    private var observedStartToken: Data?
    private var observedTokens: [String: Data] = [:]
    private var watching: [String: [Task<Void, Never>]] = [:]

    var systemAllowed: Bool { authorization.areActivitiesEnabled }
    var frequentUpdates: Bool { authorization.frequentPushesEnabled }
    var startToken: Data? { observedStartToken ?? Entry.pushToStartToken }
    var slots: Set<Int> { Set(Entry.activities.filter(Self.isLive).map(\.attributes.slot)) }

    func current(slot: Int) -> (id: String, state: MachineActivityState, token: Data?)? {
        guard let entry = entries(slot: slot).first else { return nil }
        return (entry.id, entry.content.state, observedTokens[entry.id] ?? entry.pushToken)
    }

    func observe(_ changed: @escaping @MainActor () -> Void) {
        self.changed = changed
        endLegacyActivities()
        observers = [
            Task { [weak self] in
                for await entry in Entry.activityUpdates { self?.watch(entry) }
            },
            Task { [weak self] in
                for await token in Entry.pushToStartTokenUpdates {
                    self?.observedStartToken = token
                    self?.changed?()
                }
            },
            Task { [weak self] in
                guard let updates = self?.authorization.activityEnablementUpdates else { return }
                for await _ in updates { self?.changed?() }
            },
            Task { [weak self] in
                guard let updates = self?.authorization.frequentPushEnablementUpdates else { return }
                for await _ in updates { self?.changed?() }
            },
        ]
        for entry in Entry.activities { watch(entry) }
    }

    func start(slot: Int, _ state: MachineActivityState, staleDate: Date) throws {
        guard entries(slot: slot).isEmpty else { return }
        let entry = try Entry.request(attributes: MachineActivityAttributes(slot: slot),
                                      content: ActivityContent(state: state, staleDate: staleDate), pushType: .token)
        watch(entry)
    }

    func update(slot: Int, id: String, _ state: MachineActivityState, staleDate: Date) async {
        guard let entry = entries(slot: slot).first, entry.id == id,
              entry.content.state.acceptsLocalUpdate(state) else { return }
        nonisolated(unsafe) let target = entry
        await target.update(ActivityContent(state: state, staleDate: staleDate))
    }

    func end(slot: Int, id: String, _ state: MachineActivityState?, dismissAt: Date?) async {
        guard let entry = entries(slot: slot).first(where: { $0.id == id }),
              state.map({ entry.content.state.acceptsLocalUpdate($0) }) ?? true else { return }
        nonisolated(unsafe) let target = entry
        await target.end(state.map { ActivityContent(state: $0, staleDate: nil) },
                         dismissalPolicy: dismissAt.map { .after($0) } ?? .immediate)
    }

    private static func isLive(_ entry: Entry) -> Bool {
        switch entry.activityState {
        case .active, .stale, .pending: true
        default: false
        }
    }

    private func entries(slot: Int) -> [Entry] {
        Entry.activities.filter { $0.attributes.slot == slot && Self.isLive($0) }.sorted {
            let left = $0.content.state.seq, right = $1.content.state.seq
            return left == right ? $0.id < $1.id : left > right
        }
    }

    private func watch(_ entry: Entry) {
        guard Self.isLive(entry), watching[entry.id] == nil else { return }
        nonisolated(unsafe) let target = entry
        let id = entry.id
        watching[id] = [
            Task { [weak self] in
                for await token in target.pushTokenUpdates {
                    self?.observedTokens[id] = token
                    self?.changed?()
                }
            },
            Task { [weak self] in
                for await state in target.activityStateUpdates where state == .ended || state == .dismissed {
                    self?.observedTokens.removeValue(forKey: id)
                    self?.watching.removeValue(forKey: id)?.forEach { $0.cancel() }
                    self?.changed?()
                    return
                }
            },
        ]
        // A push-to-start can cross an in-app start. Keep the activity with the newest state.
        for extra in entries(slot: entry.attributes.slot).dropFirst() {
            nonisolated(unsafe) let duplicate = extra
            Task { await duplicate.end(nil, dismissalPolicy: .immediate) }
        }
        changed?()
    }

    private func endLegacyActivities() {
        for activity in Activity<ThreadActivityAttributes>.activities {
            nonisolated(unsafe) let target = activity
            Task { await target.end(nil, dismissalPolicy: .immediate) }
        }
        for activity in Activity<AgentsActivityAttributes>.activities {
            nonisolated(unsafe) let target = activity
            Task { await target.end(nil, dismissalPolicy: .immediate) }
        }
    }
}
