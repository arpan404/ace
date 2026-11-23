import Foundation

/// A routine's trigger as Spade holds it (spade/docs/routines.md, Triggers): a schedule phrase or
/// cron, an ace thread event, or a webhook.
struct SpadeRoutineTrigger: Codable, Equatable, Hashable, Sendable {
    let kind: String
    var schedule: String?
    var event: String?
}

/// A routine in its editor (`SpadeRoutineEditor`), pure: from the routine Spade holds to the
/// form's fields and back, and the form's "when it runs" in words. The kind of trigger is one of
/// three: a time on some days, an interval, or an ace thread event. A schedule the form can't
/// show (cron, several times a day, a webhook) is kept as it is until the person picks new
/// fields, so opening and saving a routine never rewrites when it runs.
struct SpadeRoutineDraft: Equatable {
    enum Kind: String, CaseIterable, Identifiable {
        case time = "Time", interval = "Interval", event = "Event"
        var id: String { rawValue }
    }
    /// The thread events a routine can follow, in the words the form shows.
    static let events: [(value: String, words: String)] = [
        ("thread_done", "finishes"), ("thread_failed", "fails"), ("thread_needs_you", "needs you"),
    ]
    /// The intervals the form offers; another one Spade holds is added to the choices.
    static let intervals = [15, 30, 60, 120, 240, 480, 1440]
    /// Day names by Spade's day number, Sunday first.
    static let dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
    static let weekdays: Set<Int> = [1, 2, 3, 4, 5]
    static let weekends: Set<Int> = [0, 6]
    static let everyDay: Set<Int> = Set(0...6)

    var name = ""
    var instruction = ""
    var kind: Kind = .time {
        didSet { if kind != oldValue { kept = nil } }
    }
    var hour = 9 {
        didSet { if hour != oldValue { kept = nil } }
    }
    var minute = 0 {
        didSet { if minute != oldValue { kept = nil } }
    }
    /// The days it runs on, by Spade's day number (Sunday is 0).
    var days: Set<Int> = SpadeRoutineDraft.everyDay {
        didSet { if days != oldValue { kept = nil } }
    }
    var everyMinutes = 60 {
        didSet { if everyMinutes != oldValue { kept = nil } }
    }
    var event = "thread_done" {
        didSet { if event != oldValue { kept = nil } }
    }
    /// What it runs on now, in Spade's words, while the form can't show it; nil once the person
    /// chose fields of their own (or the form could show it all along).
    private(set) var kept: String?
    /// The trigger the form said as it opened; nil for a new routine.
    private var opened: SpadeRoutineTrigger?

    /// A new routine: every day at 9:00.
    init() {}

    /// The editor for a routine Spade holds, with `words` its "when it runs" from Spade.
    init(name: String, instruction: String, trigger: SpadeRoutineTrigger?, words: String) {
        self.name = name
        self.instruction = instruction
        // A kept schedule opened as nothing the form says: once the person picks new fields,
        // even the ones the form starts on (every day at 9:00), they are a change to save.
        defer { opened = trigger == nil || kept != nil ? nil : self.trigger }
        guard let trigger else {
            kept = words
            return
        }
        switch trigger.kind {
        case "event":
            kind = .event
            event = trigger.event ?? event
        case "schedule":
            if let read = Self.read(trigger.schedule ?? "") {
                kind = read.kind
                hour = read.hour
                minute = read.minute
                days = read.days
                everyMinutes = read.everyMinutes
            } else {
                kept = words
            }
        default:
            kept = words
        }
    }

    /// The form keeps a schedule it can't show; its fields are hidden until `chooseNewTime`.
    var keepsSchedule: Bool { kept != nil }

    /// The person sets a new time in place of the kept schedule: the fields show as they stand
    /// (every day at 9:00 at first), and Save sends them.
    mutating func chooseNewTime() {
        kept = nil
    }

    /// Name, what it does each time, and (with no schedule kept) days to run on.
    var ready: Bool {
        !name.trimmed.isEmpty && !instruction.trimmed.isEmpty
            && (kept != nil || kind != .time || !days.isEmpty)
    }

    /// The trigger the form says, as Spade reads it.
    var trigger: SpadeRoutineTrigger {
        switch kind {
        case .event: SpadeRoutineTrigger(kind: "event", event: event)
        case .interval: SpadeRoutineTrigger(kind: "schedule", schedule: Self.intervalPhrase(everyMinutes))
        case .time: SpadeRoutineTrigger(kind: "schedule", schedule: "\(Self.dayPhrase(days)) at \(clock)")
        }
    }

    /// The trigger to send with Save: nil while the form says what it said as it opened (Spade's
    /// own phrase stays, `every day at 9am` isn't rewritten), or it kept a schedule it can't show.
    var changedTrigger: SpadeRoutineTrigger? {
        if kept != nil { return nil }
        let next = trigger
        return next == opened ? nil : next
    }

    /// When it runs, in words: "Weekdays at 9:00", "Every 2 hours", "When a thread finishes".
    var words: String {
        if let kept { return kept }
        switch kind {
        case .event:
            let said = Self.events.first { $0.value == event }?.words ?? event
            return "When a thread \(said)"
        case .interval: return Self.intervalWords(everyMinutes)
        case .time: return "\(Self.dayWords(days)) at \(clock)"
        }
    }

    /// The interval choices, with the one it runs on now when it isn't among them.
    var intervalChoices: [Int] {
        Self.intervals.contains(everyMinutes) ? Self.intervals : (Self.intervals + [everyMinutes]).sorted()
    }

    private var clock: String { "\(hour):\(minute < 10 ? "0" : "")\(minute)" }

    // MARK: Phrases

    static func intervalPhrase(_ minutes: Int) -> String {
        if minutes == 60 { return "every hour" }
        if minutes % 60 == 0 { return "every \(minutes / 60) hours" }
        return "every \(minutes) minutes"
    }

    static func intervalWords(_ minutes: Int) -> String {
        let phrase = intervalPhrase(minutes)
        return phrase.prefix(1).uppercased() + phrase.dropFirst()
    }

    /// `daily`, `weekdays`, `weekends`, `mondays and thursdays`.
    static func dayPhrase(_ days: Set<Int>) -> String {
        if days == everyDay || days.isEmpty { return "daily" }
        if days == weekdays { return "weekdays" }
        if days == weekends { return "weekends" }
        return list(days.sorted().map { "\(dayNames[$0])s" })
    }

    /// `Every day`, `Weekdays`, `Weekends`, `Mondays and Thursdays`, as Spade says them.
    static func dayWords(_ days: Set<Int>) -> String {
        if days == everyDay || days.isEmpty { return "Every day" }
        if days == weekdays { return "Weekdays" }
        if days == weekends { return "Weekends" }
        return list(days.sorted().map { "\(dayNames[$0].capitalized)s" })
    }

    private static func list(_ items: [String]) -> String {
        guard let last = items.last else { return "" }
        return items.count == 1 ? last : "\(items.dropLast().joined(separator: ", ")) and \(last)"
    }

    // MARK: Reading Spade's phrases

    private struct Read {
        var kind: Kind
        var hour = 9
        var minute = 0
        var days: Set<Int> = SpadeRoutineDraft.everyDay
        var everyMinutes = 60
    }

    /// A phrase the form can show: an interval, or one time on some days. Nil for anything else
    /// (cron, several times, words Spade reads but the form doesn't).
    private static func read(_ schedule: String) -> Read? {
        let words = schedule.lowercased()
            .split { $0.isWhitespace || $0 == "," }
            .map(String.init)
        if words.first == "every", words.count <= 3, !words.contains("at") {
            let count = words.count == 3 ? Int(words[1]) : 1
            let unit = words.last.map { $0.hasSuffix("s") ? String($0.dropLast()) : $0 }
            guard let count, count > 0 else { return nil }
            switch unit {
            case "minute", "min": return Read(kind: .interval, everyMinutes: count)
            case "hour", "hr": return Read(kind: .interval, everyMinutes: count * 60)
            default: return nil
            }
        }
        guard let at = words.firstIndex(of: "at"), words.count == at + 2,
              let time = time(words[at + 1]), let days = days(words[..<at]) else { return nil }
        return Read(kind: .time, hour: time.hour, minute: time.minute, days: days)
    }

    private static func days(_ words: ArraySlice<String>) -> Set<Int>? {
        var set = Set<Int>()
        for raw in words {
            let word = raw.hasSuffix("s") ? String(raw.dropLast()) : raw
            switch word {
            case "every", "and", "on": continue
            case "daily", "day": set.formUnion(everyDay)
            case "weekday": set.formUnion(weekdays)
            case "weekend": set.formUnion(weekends)
            default:
                guard word.count >= 3, let day = dayNames.firstIndex(where: { $0.hasPrefix(word) }) else { return nil }
                set.insert(day)
            }
        }
        return set.isEmpty ? everyDay : set
    }

    /// `9`, `9:30`, `9am`, `9:30pm`, `noon`, `midnight`.
    private static func time(_ word: String) -> (hour: Int, minute: Int)? {
        if word == "noon" { return (12, 0) }
        if word == "midnight" { return (0, 0) }
        var clock = Substring(word)
        var half: Bool?
        if clock.hasSuffix("am") { half = false; clock = clock.dropLast(2) }
        else if clock.hasSuffix("pm") { half = true; clock = clock.dropLast(2) }
        let parts = clock.split(separator: ":", omittingEmptySubsequences: false)
        guard (1...2).contains(parts.count), var hour = Int(parts[0]) else { return nil }
        let minute = parts.count == 2 && parts[1].count == 2 ? Int(parts[1]) : (parts.count == 1 ? 0 : nil)
        guard let minute, minute < 60 else { return nil }
        if let pm = half {
            guard (1...12).contains(hour) else { return nil }
            hour = hour == 12 ? (pm ? 12 : 0) : (pm ? hour + 12 : hour)
        }
        guard hour < 24 else { return nil }
        return (hour, minute)
    }
}

private extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
