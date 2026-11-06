@testable import Ace

/// A typing pause that ends only when the test says so.
@MainActor final class HeldDraftPause: DraftSaveTimer {
    private var save: (@MainActor () -> Void)?
    func schedule(_ save: @escaping @MainActor () -> Void) { self.save = save }
    func cancel() { save = nil }
    /// The person stops typing: a save waiting for the pause runs.
    func end() {
        let waiting = save
        save = nil
        waiting?()
    }
}
