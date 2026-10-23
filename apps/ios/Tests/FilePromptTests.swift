import Testing
@testable import Ace

@Suite @MainActor struct FilePromptTests {
    @Test func aRefusedChangeSaysWhatWasTriedAndOnWhat() {
        // A new file at the checkout's root names what was typed, not the empty folder.
        #expect(FilePrompt.create(folder: "").failure(typed: "notes.txt") == "Couldn't create notes.txt.")
        #expect(FilePrompt.create(folder: "docs/").failure(typed: "docs/plan.md") == "Couldn't create plan.md.")
        #expect(FilePrompt.mkdir(folder: "").failure(typed: "drafts") == "Couldn't create the folder drafts.")
        #expect(FilePrompt.rename(path: "src/old.ts").failure(typed: "src/new.ts") == "Couldn't rename old.ts.")
        #expect(FilePrompt.move(path: "src/a.ts").failure(typed: "lib/a.ts") == "Couldn't move a.ts.")
        #expect(FilePrompt.delete(path: "build/").failure(typed: "") == "Couldn't delete build.")
    }
}
