import Foundation

/// A group (ADR 0132): make one, read and change its profile, read its Library, delete, pin,
/// post to it and stop its run (`bridge/spade-requests-groups.ts`).
extension ClientModel {
    /// A message to a group: it starts a run its lead answers.
    func spadeGroupSend(_ group: String, conversation: String, text: String) async -> SpadeOutcome {
        await spadeRequest(["type": "spade.group.send", "groupId": group, "conversationId": conversation, "text": text],
                           failing: "Couldn't send")
    }
    /// Stop ends the group's whole run.
    func spadeGroupStop(_ group: String) async -> SpadeOutcome {
        await spadeRequest(["type": "spade.group.stop", "groupId": group], failing: "Couldn't stop")
    }
    /// Pins the group to the strip above the list, or unpins it, on every device.
    func spadeGroupPin(_ group: String, pinned: Bool) async -> SpadeOutcome {
        await spadeRequest(["type": "spade.group.pin", "groupId": group, "pinned": pinned],
                           failing: pinned ? "Couldn't pin" : "Couldn't unpin")
    }
    /// A new group, sent to its lead's machine (this one), its members named against it.
    func spadeGroupCreate(name: String, members: [SpadeMemberRef], lead: String) async -> SpadeGroupMade {
        let payload: [String: Any] = ["type": "spade.group.create", "name": name, "members": members.map(\.json), "lead": lead]
        return await spadeAnswer(payload, failing: "Couldn't make the club") { SpadeGroupMade(ok: false, title: $0, message: $1) }
    }
    /// The group's profile, read afresh.
    func spadeGroupRead(_ group: String) async -> SpadeGroupProfile {
        await spadeAnswer(["type": "spade.group.read", "groupId": group], failing: "Couldn't read the club") {
            SpadeGroupProfile(ok: false, title: $0, message: $1)
        }
    }
    enum SpadeMemberEdit: String {
        case add, remove
    }

    /// One change to the group: a new name, one member edit, or another lead.
    func spadeGroupEdit(_ group: String, name: String? = nil, memberEdit: (SpadeMemberEdit, SpadeMemberRef)? = nil, lead: String? = nil) async -> SpadeOutcome {
        var payload: [String: Any] = ["type": "spade.group.edit", "groupId": group]
        if let name { payload["name"] = name }
        if let (action, member) = memberEdit { payload["memberEdit"] = ["action": action.rawValue, "member": member.json] }
        if let lead { payload["lead"] = lead }
        return await spadeRequest(payload, failing: "Couldn't change the club")
    }
    /// Deletes the group and its conversation; its bots stay.
    func spadeGroupDelete(_ group: String) async -> SpadeOutcome {
        await spadeRequest(["type": "spade.group.delete", "groupId": group], failing: "Couldn't delete the club")
    }
    /// The files the group's members made answering it, newest first.
    func spadeGroupFiles(_ group: String) async -> SpadeGroupLibrary {
        await spadeAnswer(["type": "spade.group.files", "groupId": group], failing: "Couldn't read the club's files") {
            SpadeGroupLibrary(ok: false, title: $0, message: $1)
        }
    }

    /// A Spade request whose answer carries more than an outcome; a transport failure reads as a
    /// refusal with its words.
    func spadeAnswer<Answer: Decodable & Sendable>(
        _ payload: [String: Any], failing title: String, refused: (String?, String?) -> Answer
    ) async -> Answer {
        do { return try await service(payload, as: Answer.self, timeout: .seconds(30)) }
        catch is CancellationError { return refused(nil, nil) }
        catch { return refused(title, error.localizedDescription) }
    }
}

/// Why an answer was refused, in one line; nil when it went.
func spadeRefusal(_ ok: Bool, _ title: String?, _ message: String?) -> String? {
    SpadeOutcome(ok: ok, title: title, message: message).problem
}

/// A group just made: its id and its conversation, which opens.
struct SpadeGroupMade: Decodable, Sendable {
    struct Made: Decodable, Sendable {
        let group: String
        let conversation: String
    }
    let ok: Bool
    var made: Made? = nil
    var title: String? = nil
    var message: String? = nil
    var problem: String? { spadeRefusal(ok, title, message) }
}

/// A group's profile as Spade has it now (`spadeGroupProfileRow`).
struct SpadeGroupProfile: Decodable, Sendable {
    struct Group: Decodable, Equatable, Sendable {
        let id: String
        let name: String
        let conversation: String
        let lead: Lead
        let members: [SpadeGroupDraft.Member]
        var leadRef: SpadeMemberRef { SpadeMemberRef(agent: lead.agent, machine: lead.machine) }
    }
    struct Lead: Decodable, Equatable, Sendable {
        let agent: String
        let machine: String?
    }
    let ok: Bool
    var group: Group? = nil
    var title: String? = nil
    var message: String? = nil
    var problem: String? { spadeRefusal(ok, title, message) }
}

/// A group's Library: the files its members made answering it, newest first.
struct SpadeGroupLibrary: Decodable, Sendable {
    struct File: Decodable, Equatable, Sendable, Identifiable {
        let agent: String
        /// The member that made it, by name.
        let by: String
        let name: String
        let path: String
        /// When it was last written (ms).
        let at: Double
        var id: String { "\(agent)/\(path)" }
    }
    let ok: Bool
    var files: [File]? = nil
    /// Files past what one answer holds.
    var more: Int? = nil
    var title: String? = nil
    var message: String? = nil
    var problem: String? { spadeRefusal(ok, title, message) }
}
