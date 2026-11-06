import Foundation

/// What a needs-you thread waits on, read by the bridge without opening it (`inbox-needs.ts`):
/// its pending requests as the thread's strip words them (at most eight), and how many there are.
struct InboxNeeds: Decodable, Sendable {
    let total: Int
    let requests: [ApprovalRow]
}

/// Answering a request from the inbox or the needs-you run. Like the thread's strip, the answer
/// waits for the daemon's close after durable admission; the bridge re-reads the request first,
/// and a stale or refused answer gives the controls back. View-only machines send nothing.
extension ClientModel {
    /// A thread's pending requests, while the daemon still lists the thread as needing the person.
    /// The row's status is the authority: requests read for a thread that no longer waits never show.
    func needsYou(_ threadId: String) -> [ApprovalRow] {
        guard inbox[threadId]?.state == "needs_you" else { return [] }
        return (needs[threadId]?.requests ?? []).filter { $0.state == "pending" }
    }
    /// How many requests the thread waits on, counting past the ones read.
    func needsCount(_ threadId: String) -> Int {
        let shown = needsYou(threadId).count
        return shown == 0 ? 0 : max(shown, needs[threadId]?.total ?? shown)
    }

    func receiveNeeds(_ threadId: String, _ value: InboxNeeds) {
        // A request that left the list was closed by the daemon: its answer is done.
        let kept = Set(value.requests.map(\.id))
        for old in needs[threadId]?.requests ?? [] where !kept.contains(old.id) {
            if let submission = approvalSubmissions.removeValue(forKey: old.id) { approvalRequests[submission.requestId] = nil }
        }
        needs[threadId] = value.requests.isEmpty ? nil : value
    }

    /// Allow or Deny with the exact option the request offered.
    func approveNeed(_ request: ApprovalRow, in threadId: String, option: ApprovalRow.Option) {
        answerNeed(request, in: threadId, answer: ["kind": "approval", "optionId": option.id])
    }
    /// A question's picks or words, or a plan, form or browser answer, in the thread's shapes.
    func answerNeed(_ request: ApprovalRow, in threadId: String, answers: [String: [String]], dismissed: Bool) {
        answerNeed(request, in: threadId, answer: ["kind": "question", "answers": answers, "dismissed": dismissed])
    }
    func answerNeed(_ request: ApprovalRow, in threadId: String, answer: [String: Any]) {
        guard canOperate, request.state == "pending", approvalSubmissions[request.id] == nil else { return }
        let id = admissions.nextId()
        approvalSubmissions[request.id] = ApprovalSubmission(requestId: id, phase: .saving)
        approvalRequests[id] = request.id
        if !action(["type": "needs.answer", "threadId": threadId, "interactionId": request.id, "answer": answer, "requestId": id]) {
            approvalSubmissions[request.id] = nil
            approvalRequests[id] = nil
        }
    }
    /// The run opened a thread's page: read what its agent last said.
    func readNeedsWords(_ threadId: String) { action(["type": "needs.context", "threadId": threadId]) }
}
