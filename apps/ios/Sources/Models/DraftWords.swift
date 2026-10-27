import Foundation

/// Words handed back for a thread's composer: the message that wasn't sent (Edit), or what a
/// stopped runtime was handing back when it stopped (`bridge/take-back-ledger.ts`).
struct GivenWords: Equatable, Sendable, Identifiable {
    let id = UUID()
    let threadId: String
    let text: String
    /// The take-back record to acknowledge once the words are saved; nil when there is none.
    let record: String?
}

/// Words just written into a saved draft, which a composer showing that draft merges into what is
/// on screen (its own next save then keeps them).
struct DraftAppend: Equatable {
    let key: String
    let restore: ComposerRestore
}

extension ThreadDrafts {
    /// Words go after what the draft holds, past a blank line, and are saved at once. True once
    /// they are on disk.
    @discardableResult func give(_ text: String, for key: String) -> Bool {
        save(ComposerRestore(text: text).merged(into: self.text(for: key)), picks: picks(for: key), for: key)
    }
}

@MainActor extension ClientModel {
    /// Each given word into its thread's saved draft, then the record acknowledged, once saved.
    /// Words that couldn't be saved stay given and are tried again.
    func drainGivenWords(into drafts: ThreadDrafts) {
        guard let hostId, !givenWords.isEmpty else { return }
        var kept: [GivenWords] = []
        for words in givenWords {
            let key = ThreadDrafts.key(hostId: hostId, threadId: words.threadId)
            guard drafts.give(words.text, for: key) else { kept.append(words); continue }
            draftAppend = DraftAppend(key: key, restore: ComposerRestore(text: words.text))
            if let record = words.record { acknowledgeWords(record) }
        }
        givenWords = kept
    }
}

import SwiftUI

/// Writes each machine's given words into the saved drafts as they arrive, at any screen: a
/// recovered take-back lands in its thread's draft even while another thread is open.
struct DraftWordsDrain: View {
    let model: ClientModel
    @Environment(\.threadDrafts) private var drafts
    var body: some View {
        Color.clear
            .accessibilityHidden(true)
            .onChange(of: model.givenWords, initial: true) { _, _ in
                if let drafts { model.drainGivenWords(into: drafts) }
            }
    }
}
