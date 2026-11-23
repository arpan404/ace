import Foundation

extension ClientModel {
    /// The Spade tab shows this machine's bots, or no longer does.
    func spadeWatch(_ on: Bool) {
        guard spade.watching != on else { return }
        spade.watching = on
        action(["type": "spade.watch", "on": on])
    }
    /// The app's scene is active or no longer is: the bridge reads the bots only while it is.
    func spadeActive(_ on: Bool) {
        guard spade.active != on else { return }
        spade.active = on
        action(["type": "spade.active", "active": on])
    }
    /// Follow `id` live, or no conversation; a group's (ADR 0132) names its `group`.
    func spadeOpen(_ id: String?, group: String? = nil) {
        guard spade.opened != id || spade.openedGroup != group else { return }
        spade.opened = id
        spade.openedGroup = id == nil ? nil : group
        action(Self.spadeOpening(id, group: spade.openedGroup))
    }
    private static func spadeOpening(_ id: String?, group: String?) -> [String: Any] {
        var payload: [String: Any] = ["type": "spade.open", "conversationId": id.map { $0 as Any } ?? NSNull()]
        if let group { payload["group"] = group }
        return payload
    }
    func spadeRetry() { action(["type": "spade.retry"]) }
    /// Read Spade's state and the bots again now.
    func spadeRefresh() { action(["type": "spade.refresh"]) }
    /// Who the person is and their organizations' members, for who may answer a shared bot.
    func spadePeople(_ people: SpadePeople) {
        guard spade.people != people else { return }
        spade.people = people
        action(people.action)
    }
    /// A new runtime knows nothing of what shows: tell it again.
    func spadeResume() {
        if let people = spade.people { action(people.action) }
        if !spade.active { action(["type": "spade.active", "active": false]) }
        if spade.watching { action(["type": "spade.watch", "on": true]) }
        if let id = spade.opened { action(Self.spadeOpening(id, group: spade.openedGroup)) }
    }
    /// A Spade request; a transport failure reads as a refusal with its words.
    func spadeRequest(_ payload: [String: Any], failing title: String, timeout: Duration = .seconds(70)) async -> SpadeOutcome {
        do { return try await service(payload, as: SpadeOutcome.self, timeout: timeout) }
        catch is CancellationError { return SpadeOutcome(ok: false) }
        catch { return SpadeOutcome(ok: false, title: title, message: error.localizedDescription) }
    }
}

extension MachineInbox {
    /// The machines that show Spade (Settings › Beta), in the inbox's order: the Spade tab is
    /// there while any does.
    var spadeSessions: [MachineSession] { sessions.filter { $0.client.spade.shown == true } }
    /// A Spade bot works on a machine that shows Spade: the tab's face moves its eyes.
    var spadeWorking: Bool {
        spadeSessions.contains { $0.client.spade.bots?.contains { $0.state == "working" } == true }
    }
}

/// The person's account id and their organizations' members' names by account (ADR 0206 §2.3).
struct SpadePeople: Equatable, Sendable {
    let me: String?
    let names: [String: String]

    @MainActor init(spaces: SpacesModel) {
        me = spaces.accountId
        var names: [String: String] = [:]
        for member in spaces.members.values.joined() {
            let name = [member.name, member.email].compactMap { $0 }.first { !$0.isEmpty }
            if let name { names[member.account] = name }
        }
        self.names = names
    }
    var action: [String: Any] {
        ["type": "spade.people", "people": ["self": me.map { $0 as Any } ?? NSNull(), "names": names]]
    }
}
