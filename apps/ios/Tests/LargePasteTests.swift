import Foundation
import Testing
@testable import Ace

@Suite struct LargePasteTests {
    private func lines(_ count: Int) -> String { (0..<count).map { "line \($0)" }.joined(separator: "\n") }
    private func staging() -> AttachmentStaging {
        AttachmentStaging(root: FileManager.default.temporaryDirectory.appendingPathComponent("large-paste-\(UUID().uuidString)", isDirectory: true))
    }

    @Test func aShortPasteStaysInTheMessage() {
        #expect(LargePaste.file(for: "npm run build") == nil)
        #expect(LargePaste.file(for: lines(40)) == nil)
        #expect(LargePaste.file(for: String(repeating: "x", count: 2_048)) == nil)
    }
    @Test func moreThanFortyLinesBecomesATextFileNamedForItsLineCount() {
        #expect(LargePaste.file(for: lines(41) + "\n") == LargePaste.File(name: "Pasted 41 lines.txt", lines: 41))
        #expect(LargePaste.file(for: lines(41).replacingOccurrences(of: "\n", with: "\r\n"))?.lines == 41)
    }
    @Test func aTrailingWindowsLineBreakEndsTheLastLineAsTheWebCountsIt() {
        let crlf = (0..<41).map { "line \($0)" }.joined(separator: "\r\n")
        #expect(LargePaste.file(for: crlf + "\r\n")?.lines == 41)
        #expect(LargePaste.file(for: lines(40).replacingOccurrences(of: "\n", with: "\r\n") + "\r\n") == nil)
    }
    @Test func blankLinesAtTheEndCountPastTheFirstBreak() {
        // Only one trailing break ends the last line: each further one is a blank line, as on the web.
        #expect(LargePaste.file(for: lines(40) + "\n") == nil)
        #expect(LargePaste.file(for: lines(40) + "\n\n")?.lines == 41)
        #expect(LargePaste.file(for: lines(40) + "\r\n\r\n")?.lines == 41)
        #expect(LargePaste.file(for: lines(39) + "\n\n") == nil)
    }
    @Test func oneVeryLongLineBecomesAFileToo() {
        #expect(LargePaste.file(for: String(repeating: "x", count: 2_049)) == LargePaste.File(name: "Pasted 1 line.txt", lines: 1))
    }
    @Test func whetherAPasteIsLongIsDecidedAsItsFileIs() {
        for paste in ["npm run build", lines(40), lines(41), lines(40) + "\n\n", String(repeating: "x", count: 2_048),
                      String(repeating: "x", count: 2_049), String(repeating: "é\n", count: 30)] {
            #expect(LargePaste.isLong(paste) == (LargePaste.file(for: paste) != nil))
        }
    }
    @Test func onlyAPastesOwnNameMarksAFileAsAPaste() {
        #expect(LargePaste.isPasted("Pasted 41 lines.txt"))
        #expect(LargePaste.isPasted("Pasted 1 line.txt"))
        #expect(!LargePaste.isPasted("server.log"))
        #expect(!LargePaste.isPasted("Pasted 3 lines.txt.bak"))
    }
    @Test func aLargePasteIsStagedAsAPlainTextFileHoldingExactlyThePaste() async throws {
        let staging = staging()
        defer { try? FileManager.default.removeItem(at: staging.root) }
        let log = lines(120) + "\nended with é\n"
        guard case .file(let file) = await ComposerIntake.stage(paste: log, into: staging) else {
            Issue.record("the paste wasn't staged as a file"); return
        }
        #expect(file.name == "Pasted 121 lines.txt")
        #expect(file.mimeType == "text/plain")
        #expect(file.bytes == log.utf8.count)
        #expect(await ComposerIntake.pastedText(file.localId, in: staging) == log)
    }
    @Test func aShortPasteStagesNothing() async {
        let staging = staging()
        defer { try? FileManager.default.removeItem(at: staging.root) }
        #expect(await ComposerIntake.stage(paste: "just a line", into: staging) == .words)
        #expect(!FileManager.default.fileExists(atPath: staging.root.path))
    }
    @Test func aPastePastTheFileLimitIsRefusedInWordsAndNeverStaged() async {
        let staging = staging()
        defer { try? FileManager.default.removeItem(at: staging.root) }
        let log = lines(200)
        let refused = await ComposerIntake.stage(paste: log, into: staging, limit: log.utf8.count - 1)
        #expect(refused == .refused("Too large: files can be up to 512 MB each"))
        #expect(!FileManager.default.fileExists(atPath: staging.root.path))
        // At the limit it still goes.
        guard case .file = await ComposerIntake.stage(paste: log, into: staging, limit: log.utf8.count) else {
            Issue.record("a paste at the limit was refused"); return
        }
    }
    @Test func aPastedFileCanGoBackAsTextWhileItsCopyIsHereWhateverItsUpload() async throws {
        let staging = staging()
        defer { try? FileManager.default.removeItem(at: staging.root) }
        guard case .file(let file) = await ComposerIntake.stage(paste: lines(60), into: staging) else {
            Issue.record("not staged"); return
        }
        func chip(state: String, name: String = file.name, bytes: Int = file.bytes, carried: AttachmentFile.Carried? = nil) -> AttachmentFile {
            AttachmentFile(id: file.localId, name: name, kind: "file", bytes: bytes, state: state, progress: 0, error: "", carried: carried)
        }
        #expect(ComposerIntake.restorable(chip(state: "uploading"), in: staging))
        // An upload that failed (the connection dropped) leaves the paste on the phone.
        #expect(ComposerIntake.restorable(chip(state: "failed"), in: staging))
        // A file of the same name that the person attached, or one carried from an edited message, isn't a paste here.
        #expect(!ComposerIntake.restorable(chip(state: "ready", name: "notes.txt"), in: staging))
        #expect(!ComposerIntake.restorable(chip(state: "ready", carried: .init(itemId: "i", ref: "r", thumbnail: false)), in: staging))
        // Too long for the field: it stays a file.
        #expect(!ComposerIntake.restorable(chip(state: "ready", bytes: ComposerIntake.restoreBytes + 1), in: staging))
        // Too long to go back, it says so instead of simply having no Paste as Text.
        #expect(ComposerIntake.staysAttached(chip(state: "failed", bytes: ComposerIntake.restoreBytes + 1), in: staging)
                == "Pastes over 1 MB stay as attachments")
        #expect(ComposerIntake.staysAttached(chip(state: "ready"), in: staging) == nil)
        #expect(ComposerIntake.staysAttached(chip(state: "ready", name: "notes.txt", bytes: ComposerIntake.restoreBytes + 1), in: staging) == nil)
        staging.discard(file.localId)
        #expect(!ComposerIntake.restorable(chip(state: "ready"), in: staging))
    }
}
