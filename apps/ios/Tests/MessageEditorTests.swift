import Testing
@testable import Ace

/// The edit sheet's model: it starts from the message's full words, and a save that is refused
/// keeps the sheet's words and says why.
@Suite @MainActor struct MessageEditorTests {
    @Test func theSheetStartsFromTheFullWordsNotThePreview() async {
        let long = String(repeating: "keep every message in order. ", count: 400) + "END"
        let editor = MessageEditor(attachments: 1, read: { WordsRequests.Answer(text: long, message: "") }, write: { _ in nil })
        await editor.load()
        #expect(editor.text == long)
        #expect(editor.canSave)
    }

    @Test func aRefusedSaveKeepsTheEditedWordsAndSaysWhy() async {
        var written: [String] = []
        let editor = MessageEditor(attachments: 0, read: { WordsRequests.Answer(text: "Add retries", message: "") }) { words in
            written.append(words)
            return "That message has changed. Check the queue and try again."
        }
        await editor.load()
        editor.text = "Add retries with backoff"
        #expect(await editor.save() == false)
        #expect(editor.text == "Add retries with backoff")
        #expect(editor.problem == "That message has changed. Check the queue and try again.")
        #expect(written == ["Add retries with backoff"])
    }

    @Test func aSavedEditClosesTheSheet() async {
        let editor = MessageEditor(attachments: 0, read: { WordsRequests.Answer(text: "Add retries", message: "") }, write: { _ in nil })
        await editor.load()
        editor.text = "Add retries now"
        #expect(await editor.save())
        #expect(editor.problem == nil)
    }

    @Test func nothingCanBeSavedUntilTheFullWordsAreRead() async {
        let editor = MessageEditor(attachments: 0, read: { WordsRequests.Answer(ok: false, text: nil, message: "Couldn't reach your computer.") },
                                   write: { _ in nil })
        await editor.load()
        #expect(!editor.canSave)
        #expect(await editor.save() == false)
        #expect(editor.problem == "Couldn't reach your computer.")
    }
}
