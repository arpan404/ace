import Foundation

/// A group (ADR 0132): post to it and stop its run (`bridge/spade-requests-groups.ts`).
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
}
