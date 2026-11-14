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
    @Test func oneVeryLongLineBecomesAFileToo() {
        #expect(LargePaste.file(for: String(repeating: "x", count: 2_049)) == LargePaste.File(name: "Pasted 1 line.txt", lines: 1))
    }
    @Test func onlyAPastesOwnNameMarksAFileAsAPaste() {
        #expect(LargePaste.isPasted("Pasted 41 lines.txt"))
        #expect(LargePaste.isPasted("Pasted 1 line.txt"))
        #expect(!LargePaste.isPasted("server.log"))
        #expect(!LargePaste.isPasted("Pasted 3 lines.txt.bak"))
    }
    @Test func aLargePasteIsStagedAsAPlainTextFileHoldingExactlyThePaste() throws {
        let staging = staging()
        defer { try? FileManager.default.removeItem(at: staging.root) }
        let log = lines(120) + "\nended with é\n"
        let file = try #require(ComposerIntake.stage(paste: log, into: staging))
        #expect(file.name == "Pasted 121 lines.txt")
        #expect(file.mimeType == "text/plain")
        #expect(file.bytes == log.utf8.count)
        #expect(ComposerIntake.pastedText(file.localId, in: staging) == log)
    }
    @Test func aShortPasteStagesNothing() {
        let staging = staging()
        defer { try? FileManager.default.removeItem(at: staging.root) }
        #expect(ComposerIntake.stage(paste: "just a line", into: staging) == nil)
        #expect(!FileManager.default.fileExists(atPath: staging.root.path))
    }
}
