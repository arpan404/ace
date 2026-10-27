import Foundation
import Observation

/// Previous message in the composer: the words typed before the first recall stay as the baseline,
/// and each recall shows the baseline with one earlier message after it, so walking back never
/// eats what was typed.
struct ComposerRecall: Equatable {
    let older: Int
    let baseline: String
    /// What the composer shows: the baseline, then the recalled message.
    let shown: String
    init(older: Int, recalled: String, baseline: String) {
        self.older = older
        self.baseline = baseline
        shown = ComposerRestore(text: recalled).merged(into: baseline)
    }
    /// How far back the next recall goes, and the words it keeps: one further while the composer
    /// still shows the last recall, else the latest, after what is typed now.
    static func next(after last: ComposerRecall?, draft: String) -> (older: Int, baseline: String) {
        if let last, last.shown == draft { return (last.older + 1, last.baseline) }
        return (0, draft)
    }
}

/// The composer's Previous message: each pick puts one earlier sent message after the words typed
/// before the first pick. A message that comes back after the person typed is dropped, so typing
/// is never overwritten.
@MainActor @Observable final class ComposerRecaller {
    enum Outcome: Equatable {
        case recalled
        /// Nothing to recall, in words for the composer's notice.
        case none(String)
        /// The person typed while it was read: left as they have it.
        case skipped
    }
    private(set) var last: ComposerRecall?

    func recall(into draft: ComposerDraft, fetch: (Int) async -> String?) async -> Outcome {
        let step = ComposerRecall.next(after: last, draft: draft.text)
        let asked = draft.text
        let found = await fetch(step.older)
        guard draft.text == asked else { return .skipped }
        guard let found else { return .none(step.older == 0 ? "No earlier message to use" : "That was the first message") }
        let next = ComposerRecall(older: step.older, recalled: found, baseline: step.baseline)
        draft.text = next.shown
        last = next
        return .recalled
    }
}
