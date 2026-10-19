import Foundation
import Testing
@testable import Ace

@Suite @MainActor struct TaskProfileTests {
    @Test func profilesSurviveRelaunchAndEditingDoesNotDuplicateThem() throws {
        let suite = "ace.profile.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = TaskProfileStore(defaults: defaults)
        var profile = TaskProfile(id: "reviewer", name: "Reviewer", instructions: "Check restart durability.")
        try store.save(profile)
        profile.instructions = "Check replay after a lost receipt."
        try store.save(profile)
        #expect(TaskProfileStore(defaults: defaults).load() == [profile])
        try store.remove(profile.id)
        #expect(store.load().isEmpty)
    }
    @Test func customInstructionsAreExplicitFirstMessageContentAndBlankInstructionsLeaveTheTaskUntouched() {
        var draft = NewThreadDraft()
        draft.text = "Fix the race"
        draft.instructions = "Act as a careful reviewer."
        #expect(draft.outgoingText == "Instructions:\nAct as a careful reviewer.\n\nTask:\nFix the race")
        draft.instructions = " "
        #expect(draft.outgoingText == "Fix the race")
    }
}
