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
    /// person's setting; a new one starts as the new review says.
    func carried(onto fresh: MarketChoices) -> MarketChoices {
        MarketChoices(bots: bots,
                      needs: fresh.needs.merging(needs.filter { fresh.needs[$0.key] != nil }) { $1 },
                      startRoutines: startRoutines,
                      effects: fresh.effects.map { start in start.merging((effects ?? [:]).filter { start[$0.key] != nil }) { $1 } })
    }
}

/// The review sheet's state, pure (spec items 7, 9 to 14): the review the machine holds, the
/// pages read so far, the person's switches and the last refusal. Install waits until every page
/// is read; an expired or replaced review is dropped and read again; any other refusal keeps the
/// review and its choices so Install can run again.
struct MarketReviewState: Equatable {
    private(set) var review: MarketReview?
    private(set) var rows: [MarketReviewRow] = []
    /// Where the next page starts; nil once every page is read.
    private(set) var nextOffset: Int? = 0
    private(set) var complete = false
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

    /// A bot or plugin refused for the person's standing, which this phone can't prove yet: it
    /// says to install from the computer instead (until #2499).
    var needsComputer: Bool { review?.personOnly == true && refusal?.way == .confirm }

    var canInstall: Bool { review != nil && complete && stuck == nil && !installing && !needsComputer }

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
