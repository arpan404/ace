import Foundation
import Testing
@testable import Ace

/// A routine's editor: what Spade holds opens as the form's fields, the form saves as a trigger
/// Spade reads, and a schedule the form can't show is never rewritten by opening and saving.
@Suite struct SpadeRoutineDraftTests {
    private static func schedule(_ phrase: String) -> SpadeRoutineTrigger {
        SpadeRoutineTrigger(kind: "schedule", schedule: phrase)
    }

    /// Each schedule Spade may hold: the kind it opens as, its words, and what Save would send
    /// once the form is touched.
    static let opens: [(phrase: String, kind: SpadeRoutineDraft.Kind, words: String, sends: String)] = [
        ("daily at 9:00", .time, "Every day at 9:00", "daily at 9:00"),
        ("every day at 9am", .time, "Every day at 9:00", "daily at 9:00"),
        ("weekdays at 9:00", .time, "Weekdays at 9:00", "weekdays at 9:00"),
        ("weekends at 10:30", .time, "Weekends at 10:30", "weekends at 10:30"),
        ("mondays and thursdays at 6:30pm", .time, "Mondays and Thursdays at 18:30", "mondays and thursdays at 18:30"),
        ("mon, wed, fri at noon", .time, "Mondays, Wednesdays and Fridays at 12:00",
         "mondays, wednesdays and fridays at 12:00"),
        ("at midnight", .time, "Every day at 0:00", "daily at 0:00"),
        ("every 30 minutes", .interval, "Every 30 minutes", "every 30 minutes"),
        ("every hour", .interval, "Every hour", "every hour"),
        ("every 2 hours", .interval, "Every 2 hours", "every 2 hours"),
    ]

    @Test(arguments: opens)
    func aScheduleOpensAsItsFields(_ row: (phrase: String, kind: SpadeRoutineDraft.Kind, words: String, sends: String)) {
        let draft = SpadeRoutineDraft(name: "Brief", instruction: "Sum up", trigger: Self.schedule(row.phrase), words: "Spade's words")
        #expect(draft.kind == row.kind)
        #expect(draft.words == row.words)
        #expect(draft.trigger == Self.schedule(row.sends))
        // Opened and saved as it was: Spade's own phrase stays.
        #expect(draft.changedTrigger == nil)
    }

    /// Cron, several times a day and a webhook: shown in Spade's words, and kept on Save.
    static let kept: [SpadeRoutineTrigger] = [
        schedule("0 */2 * * 1-5"),
        schedule("at 7:00 and 19:00"),
        SpadeRoutineTrigger(kind: "webhook"),
    ]

    @Test(arguments: kept)
    func aScheduleTheFormCantShowIsKeptOnSave(_ trigger: SpadeRoutineTrigger) {
        let draft = SpadeRoutineDraft(name: "Brief", instruction: "Sum up", trigger: trigger, words: "Cron 0 */2 * * 1-5")
        #expect(draft.words == "Cron 0 */2 * * 1-5")
        #expect(draft.changedTrigger == nil)
        #expect(draft.ready)
    }

    @Test func choosingFieldsReplacesAKeptSchedule() {
        var draft = SpadeRoutineDraft(name: "Brief", instruction: "Sum up", trigger: Self.schedule("0 9 * * *"), words: "Cron 0 9 * * *")
        draft.kind = .interval
        draft.everyMinutes = 120
        #expect(draft.words == "Every 2 hours")
        #expect(draft.changedTrigger == Self.schedule("every 2 hours"))
    }

    @Test func anUnchangedRoutineSendsNoTriggerAndARetimedOneDoes() {
        var draft = SpadeRoutineDraft(name: "Brief", instruction: "Sum up", trigger: Self.schedule("weekdays at 9:00"), words: "")
        #expect(draft.changedTrigger == nil)
        draft.hour = 8
        draft.minute = 5
        #expect(draft.changedTrigger == Self.schedule("weekdays at 8:05"))
        #expect(draft.words == "Weekdays at 8:05")
    }

    @Test func anEventRoutineOpensOnItsEventAndSavesIt() {
        var draft = SpadeRoutineDraft(name: "Triage", instruction: "Look",
                                      trigger: SpadeRoutineTrigger(kind: "event", event: "thread_failed"), words: "")
        #expect(draft.kind == .event)
        #expect(draft.words == "When a thread fails")
        draft.event = "thread_needs_you"
        #expect(draft.changedTrigger == SpadeRoutineTrigger(kind: "event", event: "thread_needs_you"))
    }

    @Test func aNewRoutineRunsEveryDayAtNineAndNeedsANameAndWhatItDoes() {
        var draft = SpadeRoutineDraft()
        #expect(!draft.ready)
        draft.name = "Brief"
        draft.instruction = "  "
        #expect(!draft.ready)
        draft.instruction = "Sum up the night"
        #expect(draft.ready)
        #expect(draft.changedTrigger == Self.schedule("daily at 9:00"))
        draft.days = []
        #expect(!draft.ready)
    }

    @Test func anIntervalTheFormDoesntListIsAmongItsChoices() {
        let draft = SpadeRoutineDraft(name: "Poll", instruction: "Check", trigger: Self.schedule("every 45 minutes"), words: "")
        #expect(draft.intervalChoices.contains(45))
        #expect(draft.intervalChoices == draft.intervalChoices.sorted())
    }
}
