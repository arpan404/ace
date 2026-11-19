import AppIntents
import Foundation

/// Allow or Deny from the Live Activity's expanded Dynamic Island and Lock Screen view. A
/// `LiveActivityIntent` runs in the app's process, which answers it on the machine that raised
/// the request through the same path as a notification's buttons (`LockScreenActions`).
struct AnswerRequestIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Answer a request"
    static let isDiscoverable = false

    @Parameter(title: "Machine") var hostId: String
    @Parameter(title: "Thread") var threadId: String
    @Parameter(title: "Request") var interactionId: String
    @Parameter(title: "Allow option") var approve: String
    @Parameter(title: "Deny option") var deny: String
    @Parameter(title: "Allow") var allow: Bool

    init() {}
    init(_ request: LockRequest, allow: Bool) {
        hostId = request.hostId
        threadId = request.threadId
        interactionId = request.interactionId
        approve = request.approve
        deny = request.deny
        self.allow = allow
    }

    func perform() async throws -> some IntentResult {
        let request = LockRequest(hostId: hostId, threadId: threadId, interactionId: interactionId, approve: approve, deny: deny,
                                  sentence: "", detail: "", code: false, title: "")
        await LockScreenActions.run(request, allow: allow)
        return .result()
    }
}

/// Where a Live Activity answer goes: the app's notification coordinator sets this at launch.
/// The widget extension never sets it; its intents run in the app.
@MainActor enum LockScreenActions {
    static var handler: (@MainActor (LockRequest, Bool) async -> Void)?
    static func run(_ request: LockRequest, allow: Bool) async { await handler?(request, allow) }
}
