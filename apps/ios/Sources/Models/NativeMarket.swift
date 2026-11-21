import Foundation

// The marketplace as `bridge/market.ts` sends it: rows and pages with their words already
// written by `@ace/ui-core/market`, so the views only draw. Every answer says whether it is
// the last one kept while the machine is offline.

/// An entry by where it is listed: what `read` and `prepare` name.
struct MarketEntryKey: Hashable, Sendable {
    let source: String
    let type: String
    let name: String
    var operation: [String: Any] { ["source": source, "type": type, "name": name] }
}

/// What an installed row is updated, removed or turned on by: a bot package's by its bot.
struct MarketInstalledKey: Hashable, Sendable {
    let type: String
    let name: String
    var bot: String?
    var operation: [String: Any] {
        var value: [String: Any] = ["type": type, "name": name]
        if let bot { value["bot"] = bot }
        return value
    }
}

/// A listing as a row (`market-rows.ts` `entryRow`).
struct MarketListing: Decodable, Identifiable, Hashable {
    let id: String
    let source: String
    let type: String
    let name: String
    let title: String
    let line: String
    let typeWord: String
    let publisher: String?
    let verified: Bool
    let byAce: Bool
    let reviewed: Bool
    let supported: Bool
    let version: String?
    /// The first listing picture's hash, read with `marketPicture`.
    let picture: String?
    /// Why it has no Get ("Needs a newer ace"), when it can't be installed here.
    let block: String?
    var key: MarketEntryKey { MarketEntryKey(source: source, type: type, name: name) }
}

/// An install as a row (`market-rows.ts` `installedRow`).
struct MarketInstall: Decodable, Identifiable, Hashable {
    let id: String
    let source: String
    let type: String
    let name: String
    let title: String
    let typeWord: String
    let version: String
    let hash: String
    let bot: String?
    let update: String?
    /// `on`, `withdrawn`, `blocked` or `off`.
    let state: String
    /// A Spade skill installed without the person: no bot sees it until they turn it on.
    let waitsForBots: Bool
    let status: String
    var key: MarketInstalledKey { MarketInstalledKey(type: type, name: name, bot: bot) }
}

struct MarketHome: Decodable, Equatable {
    struct Category: Decodable, Identifiable, Hashable { let id: String; let title: String; let countText: String }
    let offline: Bool
    let featured: [MarketListing]
    let categories: [Category]
    let installed: Int
    let updates: Int
    /// "2 updates", the Marketplace entry's trailing word; nil with none.
    let updatesText: String?
}

struct MarketDiscover: Decodable, Equatable {
    /// A trending row: the listing and its place this week.
    struct Ranked: Decodable, Identifiable, Hashable {
        private enum Keys: String, CodingKey { case rank }
        let row: MarketListing
        let rank: Int
        var id: String { row.id }
        init(from decoder: any Decoder) throws {
            row = try MarketListing(from: decoder)
            rank = try decoder.container(keyedBy: Keys.self).decode(Int.self, forKey: .rank)
        }
    }
    struct Collection: Decodable, Identifiable, Hashable { let id: String; let title: String; let line: String; let rows: [MarketListing] }
    struct Publisher: Decodable, Identifiable, Hashable {
        let handle: String
        let name: String
        let avatar: String?
        let verified: Bool
        let official: Bool
        let entriesText: String
        var id: String { handle }
    }
    let offline: Bool
    let hero: MarketListing?
    let featured: [MarketListing]
    let trending: [Ranked]
    let fresh: [MarketListing]
    let collections: [Collection]
    let publishers: [Publisher]
}

struct MarketSearchPage: Decodable, Equatable {
    let offline: Bool
    let rows: [MarketListing]
    let total: Int
    let totalText: String
    /// "Listings from 3:04 PM": when the machine last read them.
    let listings: String?
}

struct MarketSources: Decodable, Equatable {
    struct Source: Decodable, Identifiable, Hashable {
        let id: String
        let kind: String
        let title: String
        let address: String
        let enabled: Bool
        let entriesText: String
        let listings: String
        let problem: String?
    }
    let offline: Bool
    let sources: [Source]
}

struct MarketPublisherPage: Decodable, Equatable {
    let offline: Bool
    let handle: String
    let name: String
    let bio: String
    let avatar: String?
    let verified: Bool
    let official: Bool
    let downloadsText: String
    let pinned: [MarketListing]
    let rows: [MarketListing]
}

struct MarketPicture: Decodable, Equatable {
    let mime: String
    /// Base64 of the picture's bytes, checked against its hash on the machine.
    let data: String
}

struct MarketEntryPage: Decodable, Equatable {
    struct Version: Decodable, Hashable { let version: String; let date: String; let size: String; let withdrawn: String? }
    struct Entry: Decodable, Equatable {
        let id: String
        let source: String
        let type: String
        let name: String
        let title: String
        let line: String
        let typeWord: String
        let publisher: String?
        let verified: Bool
        let byAce: Bool
        let reviewed: Bool
        let supported: Bool
        /// The first listing picture's hash, read with `marketPicture`.
        let picture: String?
        let description: String
        /// "By ace" or "Verified" beside the publisher; nil for neither.
        let publisherMark: String?
        /// "Reviewed by ace" or "Not reviewed by ace".
        let reviewMark: String
        /// Where it is listed: "market.acehq.dev", or a git catalog's address.
        let sourceText: String
        /// `install`, `update`, `installed` or `none`.
        let action: String
        /// "Get", "Update", "Installed"; nil when there is nothing to do.
        let actionWord: String?
        let block: String?
        let downloadsText: String
        let versions: [Version]
        let installed: MarketInstall?
        /// An installed Suit: "Wear it from ace on your computer."
        let installedNote: String?
        /// The remove confirmation's title and line, naming what goes; nil when not installed.
        let removeQuestion: String?
        let removeLine: String?
        /// "Turn back on" for a withdrawn or turned-off install.
        let turnOnWord: String?
        var key: MarketEntryKey { MarketEntryKey(source: source, type: type, name: name) }
    }
    let offline: Bool
    let entry: Entry
}

/// A review held on the daemon from `prepare` until Install or Cancel, with its words written
/// (`bridge/market-review.ts`). Its sections by type are in `MarketReviewSections.swift`.
struct MarketReview: Decodable, Equatable {
    let id: String
    let hash: String
    let type: String
    let name: String
    let title: String
    let version: String
    /// "Get Inbox", "Update Inbox", "Roll back Inbox".
    let heading: String
    /// Install's word: "Get", "Update" or "Roll back"; `pendingWord` while it runs.
    let action: String
    let pendingWord: String
    /// "Bot · Mira · 1.0.0".
    let byLine: String
    let publisher: String?
    let signed: Bool
    let signedText: String
    let reviewed: Bool
    let reviewMark: String
    /// "Read what it does before you install it." when ace hasn't reviewed it.
    let reviewNote: String?
    let updates: String?
    /// What it can do, in plain sentences, as the entry page says them.
    let canDo: [String]
    /// Where it is from, what it replaces, what it can do and expects to spend.
    let facts: [String]
    /// Every finding of the device's scan, blocks first.
    let findings: [MarketFinding]
    /// Why nothing can be installed; no Install when set.
    let blocked: String?
    /// How many rows its pages hold.
    let items: Int
    /// A bot or a plugin: installing it needs the person's standing.
    let personOnly: Bool
    /// "Install this from your computer." for a person-only install the phone can't prove.
    let standingSentence: String?
    let suit: MarketReviewSuit?
    let plugin: MarketReviewPlugin?
    let bot: MarketReviewBot?
    /// The switches as the review starts them.
    let choices: MarketChoices
}
struct MarketPrepared: Decodable { let review: MarketReview }
/// One page of a review's rows.
struct MarketReviewPage: Decodable {
    let review: MarketReview
    let rows: [MarketReviewRow]
    let nextOffset: Int?
    /// No page comes after this one.
    let complete: Bool
}

struct MarketInstalledList: Decodable, Equatable {
    let offline: Bool
    let rows: [MarketInstall]
    let updates: Int
    let updatesText: String?
}
/// Install, cancel, remove and turn on: what landed, when something did.
struct MarketDone: Decodable { let installed: MarketInstall? }

/// What a refusal's button offers.
enum MarketWay: String, Decodable {
    case retry, confirm, computer, reread
}

/// A refusal from the marketplace, one sentence from its code. `offline` means the machine
/// couldn't be reached and nothing changed.
struct MarketRefusal: LocalizedError, Equatable {
    let code: String
    let message: String
    let way: MarketWay?
    let offline: Bool
    var errorDescription: String? { message }
}
