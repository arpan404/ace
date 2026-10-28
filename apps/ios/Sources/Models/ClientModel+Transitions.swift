import Foundation

/// The open thread's transitions from its messages and menu: a fork written in the composer,
/// Pi's retry and rewind, bring back to parent, rename and a new title. The bridge decides what
/// each does (`bridge/thread-transitions.ts`); these send the person's intent.
extension ClientModel {
    /// The composer writes a fork from `start`; the refusal's words show as the screen's error.
    func openFork(_ start: ForkStart) async -> Bool {
        guard canOperate else { return false }
        let id = admissions.nextId()
        return await admissions.wait(id: id) { threadAction(["type": "fork.open", "at": start.payload, "requestId": id]) }
    }
    /// The composer goes back to writing to this thread.
    func closeFork() { threadAction(["type": "fork.cancel"]) }
    /// Pi asks the newest answer's question again from just before it.
    func retryAnswer(_ answerId: String) async -> Bool {
        guard canOperate else { return false }
        let id = admissions.nextId()
        return await admissions.wait(id: id) { threadAction(["type": "retry", "answerId": answerId, "requestId": id]) }
    }
    /// Pi continues from this answer; later turns stay on screen.
    func rewind(to itemId: String) async -> Bool {
        guard canOperate else { return false }
        let id = admissions.nextId()
        return await admissions.wait(id: id) { threadAction(["type": "rewind", "itemId": itemId, "requestId": id]) }
    }
    /// Reads what bringing this fork back starts with (`screen.mergeDraft`).
    func readMergeDraft() { threadAction(["type": "merge.draft"]) }
    /// Sends the summary to the parent; nil once the daemon took it, else the refusal's words.
    func bringBack(summary: String, includeCode: Bool) async -> String? {
        guard canOperate else { return "This phone can only view this machine." }
        let id = admissions.nextId()
        return await receipts.wait(id: id) {
            threadAction(["type": "merge", "summary": summary, "includeCode": includeCode, "requestId": id])
        }
    }
    /// Renames the thread; nil once the daemon took it, else the refusal's words.
    func rename(_ threadId: String, to title: String) async -> String? {
        guard canOperate else { return "This phone can only view this machine." }
        let id = admissions.nextId()
        return await receipts.wait(id: id) {
            action(["type": "inbox", "action": ["kind": "rename", "threadId": threadId, "title": title], "requestId": id])
        }
    }
    /// Names the thread again from its opening request; a model's title follows where one is set up.
    func retitle(_ threadId: String) async -> String? {
        guard canOperate else { return "This phone can only view this machine." }
        let id = admissions.nextId()
        return await receipts.wait(id: id) {
            action(["type": "inbox", "action": ["kind": "retitle", "threadId": threadId], "requestId": id])
        }
    }
}
