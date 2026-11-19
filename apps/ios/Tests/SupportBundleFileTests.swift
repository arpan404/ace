import Foundation
import Testing
@testable import Ace

@Suite struct SupportBundleFileTests {
    private func root() throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appending(path: "support-bundle-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    @Test func aSharedSupportBundleLeavesNothingBehind() throws {
        let root = try root()
        defer { try? FileManager.default.removeItem(at: root) }
        let file = try SupportBundleFile.write(Data("logs".utf8), name: "ace-support.tar.gz", under: root)
        #expect(file.lastPathComponent == "ace-support.tar.gz")
        #expect(try Data(contentsOf: file) == Data("logs".utf8))
        SupportBundleFile.discard(file)
        #expect(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
        // Closing Diagnostics after sharing discards again; that is harmless.
        SupportBundleFile.discard(file)
    }

    @Test func eachExportGetsItsOwnFileSoDiscardingOneKeepsTheOther() throws {
        let root = try root()
        defer { try? FileManager.default.removeItem(at: root) }
        let first = try SupportBundleFile.write(Data("a".utf8), name: "ace-support.tar.gz", under: root)
        let second = try SupportBundleFile.write(Data("b".utf8), name: "ace-support.tar.gz", under: root)
        SupportBundleFile.discard(first)
        #expect(FileManager.default.fileExists(atPath: second.path))
        #expect(!FileManager.default.fileExists(atPath: first.path))
    }
}
