import Foundation

/// The editor's code notes (`CodeNotes`): each change is made here at once, then the open thread's
/// bridge session is handed the thread's whole list (`code.set`, `bridge/thread-code-notes.ts`),
/// which Send turns into one `<code_annotations>` block after the words.
extension ClientModel {
    /// A new note on `span` of `path` in `thread`, whose text is `lines`; nil once the thread is full.
    /// `now` is the file's text as the note is added, when it may have changed since `lines`.
    func addCodeNote(_ thread: String, path: String, span: TextSpan, lines: [String], now: [String]? = nil,
                     comment: String) -> Result<String, CodeNoteRefusal> {
        add(thread, comment: comment) { id, checkout in
            codeNotes.add(thread, path: path, span: span, lines: lines, now: now, comment: comment, id: id, checkout: checkout)
        }
    }
    /// A new note on whole new-side lines of a diff of `path` (from line `first`, 1-based).
    func addDiffNote(_ thread: String, path: String, first: Int, texts: [String], comment: String) -> Result<String, CodeNoteRefusal> {
        add(thread, comment: comment) { id, checkout in
            codeNotes.add(thread, path: path, first: first, texts: texts, comment: comment, id: id, checkout: checkout)
        }
    }
    /// A note is confirmed only once it is kept on the phone, so a kill straight after never loses
    /// it; one that can't be kept is taken back, leaving the person their words to try again.
    private func add(_ thread: String, comment: String, _ adding: (String, String?) -> Void) -> Result<String, CodeNoteRefusal> {
        guard canOperate else { return .failure(.cantAct) }
        // Notes a message in flight took count too: a refusal gives them back.
        guard codeNotes[thread].count + (codeNotesInFlight[thread] ?? 0) < CodeNotes.limit else { return .failure(.full) }
        guard CodeNotes.fits(comment) else { return .failure(.tooLong) }
        let before = codeNotes
        let id = UUID().uuidString
        adding(id, checkoutKeys[thread])
        guard codeNotes.number(thread, id: id) != nil else { return .failure(.noCode) }
        guard keepCodeNotes() else {
            codeNotes = before
            return .failure(.notSaved)
        }
        sendCodeNotes(thread)
        return .success(id)
    }
    /// A diff of `path` was read again, showing `lines` of the new side: `thread`'s notes there
    /// stay, move, or turn outdated or unverified (`CodeNotes.shown`).
    func diffShown(_ thread: String, path: String, lines: [Int: String]) {
        let before = codeNotes
        codeNotes.shown(thread, path: path, lines: lines)
        if codeNotes != before { sendCodeNotes(thread) }
    }
    /// New words for a note, confirmed once kept on the phone; refused when they're longer than
    /// the agent takes, or can't be kept (the note keeps its old words, the sheet the new).
    @discardableResult
    func commentCodeNote(_ thread: String, id: String, _ comment: String) -> CodeNoteRefusal? {
        guard CodeNotes.fits(comment) else { return .tooLong }
        let before = codeNotes
        codeNotes.comment(thread, id: id, comment)
        guard keepCodeNotes() else {
            codeNotes = before
            return .notSaved
        }
        sendCodeNotes(thread)
        return nil
    }
    func removeCodeNote(_ thread: String, id: String) {
        codeNotes.remove(thread, id: id)
        keepCodeNotes()
        sendCodeNotes(thread)
    }
    func clearCodeNotes(_ thread: String) {
        codeNotes.clear(thread)
        keepCodeNotes()
        sendCodeNotes(thread)
    }
    /// A message took these notes: kept at once, so a kill can't bring them back to go twice.
    func codeNotesSent(_ thread: String, ids: [String]) {
        let before = codeNotes
        codeNotes.sent(thread, ids: ids)
        guard codeNotes != before else { return }
        keepCodeNotes()
        sendCodeNotes(thread)
    }
    /// A message on `thread` is sent by `send`, and carries the notes the bridge holds: taken
    /// first (`takeCodeNotes`), settled by the answer (`settleCodeNotes`).
    func sendingCodeNotes(_ thread: String, _ send: () async -> SendOutcome) async -> Bool {
        guard case .success(let flight) = takeCodeNotes(thread) else { return false }
        let outcome = await send()
        settleCodeNotes(flight, outcome)
        return outcome.saved
    }
    /// The notes a message is about to carry leave this phone's disk, or the message mustn't go:
    /// a relaunch must never bring back a note the machine has. Nil when there are none. They
    /// count toward the thread's limit while the message is in flight, and the bridge keeps the
    /// list it had until the answer.
    func takeCodeNotes(_ thread: String) -> Result<CodeNotesFlight?, CodeNoteRefusal> {
        let taken = codeNotes[thread]
        guard !taken.isEmpty else { return .success(nil) }
        codeNotes.clear(thread)
        guard keepCodeNotes() else {
            codeNotes.putBack(thread, taken)
            // What waits to be written is the kept list again, never the cleared one.
            keepCodeNotes()
            error = CodeNoteRefusal.notSent.message
            return .failure(.notSent)
        }
        codeNotesInFlight[thread, default: 0] += taken.count
        return .success(CodeNotesFlight(thread: thread, taken: taken, epoch: codeNotesEpoch, store: codeNotesKept))
    }
    /// The machine's answer settles a message's notes: a saved message drops those it names as
    /// carried and gives back the rest (a /goal or an answer to a question carries none); a
    /// refusal gives them all back; an unknown outcome (the runtime went first) keeps them off,
    /// so a note is never sent twice. They go back to the account and machine they came from.
    func settleCodeNotes(_ flight: CodeNotesFlight?, _ outcome: SendOutcome) {
        guard let flight else { return }
        let thread = flight.thread
        let back: [CodeNote]
        switch outcome {
        case .saved(let carried):
            let gone = Set(carried)
            back = flight.taken.filter { !gone.contains($0.id) }
        case .refused: back = flight.taken
        case .unknown: back = []
        }
        if codeNotesEpoch == flight.epoch {
            let left = (codeNotesInFlight[thread] ?? 0) - flight.taken.count
            codeNotesInFlight[thread] = left > 0 ? left : nil
            if !back.isEmpty {
                codeNotes.putBack(thread, back)
                keepCodeNotes()
            }
            sendCodeNotes(thread)
        } else if !back.isEmpty, let store = flight.store {
            // Another principal's notes are loaded now: these go back to their own. A write
            // that fails keeps that store alive until it succeeds (`CodeNotesKept`).
            var kept = store.load()
            kept.putBack(thread, back)
            store.save(kept)
        }
    }
    /// Writes the notes now; false when they couldn't be (they're tried again). True when this
    /// connection keeps none (signed out).
    @discardableResult private func keepCodeNotes() -> Bool { codeNotesKept?.save(codeNotes) ?? true }
    /// The person typed in `path`: its notes move with the edit (`line` reads the text after it).
    func codeEdited(_ thread: String, path: String, through replacements: [TextReplacement], line: (Int) -> String) {
        let before = codeNotes
        codeNotes.edited(thread, path: path, through: replacements, line: line)
        if codeNotes != before { sendCodeNotes(thread) }
    }
    /// `path`'s editor loaded new text (an agent's change, a discarded edit, the file at open).
    func codeReloaded(_ thread: String, path: String, before lines: [String]?, after: [String]) {
        let before = codeNotes
        codeNotes.reloaded(thread, path: path, before: lines, after: after)
        if codeNotes != before { sendCodeNotes(thread) }
    }
    /// A file moved or was renamed in `scope`'s checkout: the notes made in that checkout follow.
    func codeRenamed(_ scope: FilesScope, from path: String, to destination: String) async {
        guard case .thread(let renaming) = scope else { return }
        let checkout = await checkoutKey(renaming)
        let before = codeNotes
        codeNotes.renamed(in: checkout, thread: renaming, from: path, to: destination)
        if codeNotes != before, let open = thread?.id { sendCodeNotes(open) }
    }
    /// A thread's checkout as notes name it, this machine and the checkout's root; read once, nil
    /// while the root can't be read.
    @discardableResult
    func checkoutKey(_ thread: String) async -> String? {
        if let known = checkoutKeys[thread] { return known }
        guard let found = try? await files(.thread(thread), ["op": "root"], as: CheckoutRoot.self, timeout: .seconds(3)),
              let root = found.root else { return nil }
        let key = "\(hostId ?? "")\u{0}\(root)"
        checkoutKeys[thread] = key
        return key
    }
    /// The notes this phone kept for whoever the connection signs in as on its machine
    /// (`ConnectionTarget.keptScope`), as a connection begins or signs in as someone else; the
    /// last principal's are written first, and its checkouts forgotten. Signed out, none are
    /// shown or kept.
    func restoreCodeNotes(keptScope: String?, in directory: URL) {
        codeNotesKept?.flush()
        codeNotesKept = nil
        codeNotesEpoch += 1
        codeNotesInFlight = [:]
        checkoutKeys = [:]
        guard let keptScope else {
            codeNotes = CodeNotes()
            return
        }
        let kept = CodeNotesKept(url: CodeNotesKept.url(keptScope: keptScope, in: directory))
        codeNotes = kept.load()
        codeNotesKept = kept
    }
    /// The open thread's session hears `thread`'s notes; another thread's wait until it opens.
    func sendCodeNotes(_ thread: String) {
        guard canOperate, self.thread?.id == thread, codeNotesInFlight[thread] == nil else { return }
        threadAction(["type": "code.set", "notes": codeNotes.wire(thread)])
    }
}

private struct CheckoutRoot: Decodable { let root: String? }

/// Why a note wasn't added or changed, in words for the person.
enum CodeNoteRefusal: Error, Equatable {
    case cantAct, full, noCode, tooLong, notSaved, notSent

    var message: String {
        switch self {
        case .cantAct: "View only. Pair this phone with View and act to leave notes."
        case .full: "The next message already has \(CodeNotes.limit) notes."
        case .noCode: "These lines hold no code to note."
        case .tooLong: "A note can be at most \(CodeNotes.commentLimit.formatted()) characters. Shorten it."
        case .notSaved: "Couldn't keep the note on this phone. Try again."
        case .notSent: "Couldn't update the code notes on this phone, so the message wasn't sent. Try again."
        }
    }
}

/// The notes one message took, and where they came from.
struct CodeNotesFlight {
    let thread: String
    let taken: [CodeNote]
    /// The principal's notes loaded when they were taken (`ClientModel.codeNotesEpoch`).
    let epoch: Int
    let store: CodeNotesKept?
}

/// What became of a message that may carry code notes (`ClientModel.sendingCodeNotes`).
enum SendOutcome: Equatable {
    /// Saved on the machine, carrying these notes (none for a /goal or a question's answer).
    case saved(carried: [String])
    /// Definitely not saved.
    case refused
    /// Unknown: the runtime went before the machine answered.
    case unknown

    var saved: Bool { if case .saved = self { true } else { false } }
}
