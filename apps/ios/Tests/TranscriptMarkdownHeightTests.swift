import Foundation
import Testing
@testable import Ace

@Suite struct TranscriptMarkdownHeightTests {
    @Test func reopeningKeepsTheLatestMeasuredHeightForTheSameLayout() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let url = directory.appending(path: "heights.json")
        let disk = TranscriptMarkdownHeightDisk(url: url)
        await disk.save([.init(key: "hash:360:1:large:leftToRight", height: 212)])
        await disk.save([.init(key: "hash:360:1:large:leftToRight", height: 260)])

        let reopened = TranscriptMarkdownHeightDisk(url: url)
        await reopened.load()
        #expect(reopened.height(for: "hash:360:1:large:leftToRight") == 260)
        #expect(reopened.height(for: "hash:400:1:large:leftToRight") == nil)
        #expect(reopened.height(for: "hash:360:1:accessibility2:leftToRight") == nil)

        await reopened.clear()
        let cleared = TranscriptMarkdownHeightDisk(url: url)
        await cleared.load()
        #expect(cleared.height(for: "hash:360:1:large:leftToRight") == nil)
    }

    @Test func aLongConversationBoundsTheMeasurementsKeptAcrossReopen() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let url = directory.appending(path: "heights.json")
        let disk = TranscriptMarkdownHeightDisk(url: url)
        await disk.save((0..<1_500).map { .init(key: "answer-\($0)", height: Double($0 + 1)) })

        let reopened = TranscriptMarkdownHeightDisk(url: url)
        await reopened.load()
        #expect(reopened.height(for: "answer-0") == nil)
        #expect(reopened.height(for: "answer-1499") == 1_500)
    }
}
