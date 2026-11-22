import Foundation

/// The person's choices on a review, sent with Install (`MarketInstallChoices`): the bots a plugin
/// is allowed for, a recipe's need switches, whether its routines start, and a package's effect
/// switches. They start as the review says; nothing is granted until Install.
struct MarketChoices: Decodable, Equatable {
    var bots: [String]
    var needs: [String: Bool]
    var startRoutines: Bool
    /// A linked package's effect and code switches; nil for anything else.
    var effects: [String: Bool]?

    static let none = MarketChoices(bots: [], needs: [:], startRoutines: false, effects: nil)

    /// What Install sends.
    var payload: [String: Any] {
        var value: [String: Any] = ["bots": bots, "needs": needs, "startRoutines": startRoutines]
        if let effects { value["effects"] = effects }
        return value
    }

    /// These choices carried onto a review read again: every switch both reviews have keeps the
    /// person's setting; a new one starts as the new review says. Start its routines goes back to
    /// off, since the new review's routines may not be the ones the person agreed to start.
    func carried(onto fresh: MarketChoices) -> MarketChoices {
        MarketChoices(bots: bots,
                      needs: fresh.needs.merging(needs.filter { fresh.needs[$0.key] != nil }) { $1 },
                      startRoutines: false,
                      effects: fresh.effects.map { start in start.merging((effects ?? [:]).filter { start[$0.key] != nil }) { $1 } })
    }
}

/// The review sheet's state, pure (spec items 7, 9 to 14): the review the machine holds, the
/// pages read so far, the person's switches and the last refusal. Install waits until every page
/// is fetched and the person has scrolled to the end of the last one shown; an expired or
/// replaced review is dropped and read again; any other refusal keeps the review and its choices
/// so Install can run again.
struct MarketReviewState: Equatable {
    private(set) var review: MarketReview?
    private(set) var rows: [MarketReviewRow] = []
    /// Where the next page starts; nil once every page is read.
    private(set) var nextOffset: Int? = 0
    private(set) var complete = false
    /// The person's scroll reached the end with every row now shown on the page.
    private(set) var seenEnd = false
    var choices = MarketChoices.none
    private(set) var refusal: MarketRefusal?
    private(set) var installing = false
    /// The switches from a review that was dropped, kept for the one read in its place.
    private var dropped: MarketChoices?

    /// A review prepared on the machine: its pages are unread and its switches as it starts them.
    mutating func opened(_ fresh: MarketReview) {
        review = fresh
        rows = []
        nextOffset = 0
        complete = false
        seenEnd = false
        choices = dropped?.carried(onto: fresh.choices) ?? fresh.choices
        dropped = nil
        refusal = nil
    }

    /// One page read, in order; a page of another review, or out of order, is ignored.
    mutating func read(_ page: MarketReviewPage, from offset: Int) {
        guard page.review.id == review?.id, offset == nextOffset else { return }
        rows += page.rows
        nextOffset = page.complete ? nil : page.nextOffset
        complete = page.complete
        // New rows go below what was seen: the end has to be reached again.
        if !page.rows.isEmpty { seenEnd = false }
    }

    /// The scroll reached the end of the page while it showed `shown` rows of the review `id`.
    /// A report from before the last rows arrived, or of another review, doesn't count.
    mutating func reachedEnd(of id: String, shown: Int) {
        guard id == review?.id, shown == rows.count else { return }
        seenEnd = true
    }

    /// Whether the bottom of the content is in view: its last point is above the visible bottom,
    /// which sits `insetBottom` (the sheet's foot) above the container's. `slack` absorbs rounding.
    static func atEnd(offsetY: CGFloat, containerHeight: CGFloat, insetBottom: CGFloat, contentHeight: CGFloat,
                      slack: CGFloat = 2) -> Bool {
        offsetY + containerHeight - insetBottom >= contentHeight - slack
    }

    mutating func started() {
        installing = true
        refusal = nil
    }

    /// A refusal from reading or installing. `reread` drops the review (it expired or changed);
    /// anything else keeps it, read as it was.
    mutating func refused(_ refusal: MarketRefusal) {
        installing = false
        self.refusal = refusal
        guard refusal.way == .reread, review != nil else { return }
        dropped = choices
        review = nil
        rows = []
        nextOffset = 0
        complete = false
        seenEnd = false
    }

    /// Install went through: nothing more is sent from this review.
    mutating func finished() {
        installing = false
        review = nil
    }

    /// What stops Install before it is pressed: the review's block, or a required app left off.
    var stuck: String? {
        guard let review else { return nil }
        if let blocked = review.blocked { return blocked }
        return review.bot?.needs.first { $0.required && choices.needs[$0.key] != true }?.offSentence
    }

    /// An install refused for the person's standing, whatever its type: Confirm it's you or Pair
    /// again takes Install's place (`MarketConfirmPerson`).
    var needsPerson: Bool { review != nil && refusal?.asksForPerson == true }
    /// The market wants a person's grant, which only ace on the computer can get (ADR 0190 §6).
    var needsComputer: Bool { review != nil && refusal?.code == "person_grant" }

    private var ready: Bool { review != nil && complete && seenEnd && stuck == nil && !installing }
    var canInstall: Bool { ready && !needsPerson && !needsComputer }
    /// Confirm it's you sends Install once more, confirmed.
    var canConfirm: Bool { ready && refusal?.way == .confirm }

    /// Each switch's binding, read and written by key.
    func need(_ key: String) -> Bool { choices.needs[key] == true }
    mutating func setNeed(_ key: String, _ on: Bool) { choices.needs[key] = on }
    func effect(_ key: String) -> Bool { choices.effects?[key] == true }
    mutating func setEffect(_ key: String, _ on: Bool) { choices.effects?[key] = on }
    func allows(_ bot: String) -> Bool { choices.bots.contains(bot) }
    mutating func setBot(_ bot: String, _ on: Bool) {
        choices.bots.removeAll { $0 == bot }
        if on { choices.bots.append(bot) }
    }
}
