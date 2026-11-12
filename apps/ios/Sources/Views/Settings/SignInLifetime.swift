/// Owned by the whole flow's State, which survives navigation to its terminal.
@MainActor final class SignInLifetime {
    var unfinishedSession: String?
    var cancel: (@MainActor @Sendable (String) -> Void)?

    deinit {
        if let session = unfinishedSession, let cancel {
            Task { @MainActor in cancel(session) }
        }
    }
}
