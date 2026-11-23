import Testing
import UIKit
@testable import Ace

@Suite @MainActor struct SourceSaveTests {
    @Test func aSaveKeepsNewerTextDirtyAndMovesTheBaselineToTheSavedText() {
        let handle = SourceHandle()
        var changes: [Bool] = []
        let editor = SourceTextView(
            document: SourceDocument(key: "notes", text: "original", language: nil, marks: [:]),
            wrap: true, editable: true, line: nil, handle: handle, dirty: { changes.append($0) })
        let coordinator = editor.makeCoordinator()
        let text = UITextView()
        text.delegate = coordinator
        handle.view = text
        text.text = "original"
        #expect(!handle.markSaved("original"))

        text.text = "sent"
        let sent = handle.text
        text.text = "newer"
        coordinator.textViewDidChange(text)

        #expect(handle.markSaved(sent))
        #expect(handle.text == "newer")
        text.text = sent
        coordinator.textViewDidChange(text)
        #expect(changes == [true, false])

        text.text = "original"
        coordinator.textViewDidChange(text)
        #expect(changes == [true, false, true])
    }
}
