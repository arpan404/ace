import CoreText
import Foundation
import UIKit

/// A Suit's files on this phone: each asset of one version read once over the socket
/// (`suit.asset`) and kept under Caches, so a launch registers fonts and draws the still before
/// any machine answers. A version's folder is named by its content hash, so an edit never reads
/// an older file.
enum SuitAssets {
    static var root: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("suits", isDirectory: true)
    }

    /// Where one asset of one version lives, inside its version's folder only.
    static func file(_ suit: PhoneSuit, _ path: String) -> URL? {
        guard path.hasPrefix("assets/"), !path.split(separator: "/").contains(".."), suit.contentHash.allSatisfy(\.isHexDigit) else { return nil }
        return root.appendingPathComponent(suit.id).appendingPathComponent(suit.contentHash).appendingPathComponent(path)
    }

    /// The asset's file, read from `fetch` (its base64) the first time.
    static func fetched(_ suit: PhoneSuit, _ path: String, fetch: () async throws -> String) async throws -> URL {
        guard let url = file(suit, path) else { throw CocoaError(.fileReadInvalidFileName) }
        if FileManager.default.fileExists(atPath: url.path) { return url }
        guard let data = Data(base64Encoded: try await fetch()) else { throw CocoaError(.fileReadCorruptFile) }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
        return url
    }

    /// Drops every other version of this Suit, keeping the one on screen.
    static func prune(keeping suit: PhoneSuit) {
        let folder = root.appendingPathComponent(suit.id)
        let versions = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        for version in versions where version != suit.contentHash {
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(version))
        }
    }
}

/// A Suit's font slots as faces this phone can draw: a bundled file registered for this process,
/// else the first installed family it names. Nil leaves the system font.
@MainActor enum SuitFonts {
    /// Font files already registered, by path, with the face each gave.
    private static var registered: [String: String] = [:]

    static func face(_ face: PhoneSuit.Face?, file: URL?) -> String? {
        guard let face else { return nil }
        if let file { return register(file) }
        return face.families.first { !UIFont.fontNames(forFamilyName: $0).isEmpty }
    }

    /// The face a file holds, registered once; nil for a file Core Text can't read.
    private static func register(_ file: URL) -> String? {
        if let known = registered[file.path] { return known }
        guard let descriptors = CTFontManagerCreateFontDescriptorsFromURL(file as CFURL) as? [CTFontDescriptor],
              let name = descriptors.first.flatMap({ CTFontDescriptorCopyAttribute($0, kCTFontNameAttribute) as? String }) else { return nil }
        // Already registered (a relaunch's first read): the face is there to use.
        var error: Unmanaged<CFError>?
        _ = CTFontManagerRegisterFontsForURL(file as CFURL, .process, &error)
        guard UIFont(name: name, size: 12) != nil else { return nil }
        registered[file.path] = name
        return name
    }
}
