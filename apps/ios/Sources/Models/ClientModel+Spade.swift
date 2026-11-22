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
    /// A message: its words, the files staged for it (`AttachmentStaging`) and a recording. Words
    /// may be empty when it carries something; the bridge checks Spade's limits before any of it
    /// goes, and a message with files has as long as a large upload needs.
    func spadeSend(_ conversation: String, text: String, files: [StagedAttachment] = [], voice: StagedAttachment? = nil) async -> SpadeOutcome {
        var payload: [String: Any] = ["type": "spade.send", "conversationId": conversation, "text": text]
        if !files.isEmpty { payload["files"] = files.map(\.json) }
        if let voice { payload["voice"] = voice.json }
        let carries = !files.isEmpty || voice != nil
        return await spadeRequest(payload, failing: "Couldn't send", timeout: carries ? .seconds(15 * 60) : .seconds(70))
    }
    func spadeStop(_ conversation: String) async -> SpadeOutcome {
        await spadeRequest(["type": "spade.stop", "conversationId": conversation], failing: "Couldn't stop")
    }
    func spadeAnswer(_ conversation: String, callId: String, allowed: Bool, always: Bool) async -> SpadeOutcome {
        await spadeRequest(["type": "spade.answer", "conversationId": conversation, "callId": callId,
                            "allowed": allowed, "always": always], failing: "Couldn't answer")
    }
    /// A card of questions: `reply` is its drafts (`["drafts": [...]]`), `["defer": true]` or
    /// `["dismiss": true]`.
    func spadeQuestion(_ conversation: String, callId: String, reply: [String: Any]) async -> SpadeOutcome {
        await spadeRequest(["type": "spade.question", "conversationId": conversation, "callId": callId, "reply": reply],
                           failing: "Couldn't answer")
    }
    /// A sent card not yet settled: the conversation's events since the last one shown, read again.
    func spadeQuestionRead(_ conversation: String, callId: String) async -> SpadeOutcome {
        await spadeRequest(["type": "spade.question.read", "conversationId": conversation, "callId": callId],
                           failing: "Couldn't read the conversation")
    }
    /// A message to a group: it starts a run its lead answers.
    func spadeGroupSend(_ group: String, conversation: String, text: String) async -> SpadeOutcome {
        await spadeRequest(["type": "spade.group.send", "groupId": group, "conversationId": conversation, "text": text],
                           failing: "Couldn't send")
    }
    /// Stop ends the group's whole run.
    func spadeGroupStop(_ group: String) async -> SpadeOutcome {
        await spadeRequest(["type": "spade.group.stop", "groupId": group], failing: "Couldn't stop")
    }
    /// A bot's profile, read afresh.
    func spadeProfile(_ agent: String) async -> SpadeProfileAnswer {
        let failed = { (message: String?) in
            SpadeProfileAnswer(ok: false, profile: nil, title: "Couldn't read the profile", message: message)
        }
        do {
            return try await service(["type": "spade.profile", "agentId": agent], as: SpadeProfileAnswer.self,
                                     timeout: .seconds(30))
        } catch is CancellationError { return failed(nil) }
        catch { return failed(error.localizedDescription) }
    }
    /// The bot's task, as the person rewrote it.
    func spadeTask(_ agent: String, task: String) async -> SpadeOutcome {
        await spadeRequest(["type": "spade.task", "agentId": agent, "task": task], failing: "Couldn't save the task")
    }
    func spadeTurnOn() async -> SpadeOutcome {
        await spadeRequest(["type": "spade.enable"], failing: "Couldn't turn on Spade")
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
