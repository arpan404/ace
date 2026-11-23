import Foundation

// What the bridge's publish steps answer (`bridge/market-publishing.ts`), with their words
// already written (`bridge/market-publish-words.ts`). Swift only draws them.

struct MarketPublisherProfile: Decodable, Equatable {
    struct Link: Codable, Hashable {
        var label: String
        var url: String
    }
    let handle: String
    let name: String
    let bio: String
    let links: [Link]
    /// The avatar picture's hash, read with `marketPicture(_, kind: "avatar")`.
    let avatar: String?
    let verified: Bool
}

/// One of the publisher's own listings.
struct MarketOwnListing: Decodable, Identifiable, Hashable {
    let id: String
    let type: String
    let name: String
    let title: String
    let line: String
    let typeWord: String
    let version: String?
    let status: String?
    /// "1.2.0 · Live".
    let statusText: String
    let downloadsText: String
    /// "2 open reports"; nil when there are none.
    let reportsText: String?
}

struct MarketOwnDraft: Decodable, Identifiable, Hashable {
    let id: String
    let type: String
    let name: String
    let title: String
    let typeWord: String
    let version: String
    let stateText: String
}

/// The signed-in publisher's page: Your listings.
struct MarketMePage: Decodable, Equatable {
    let profile: MarketPublisherProfile?
    let suspended: Bool
    let listings: [MarketOwnListing]
    let drafts: [MarketOwnDraft]
    let limitText: String
}

/// One of the person's own things that can be published.
struct MarketPublishable: Decodable, Identifiable, Hashable {
    /// Where its files come from, as the bridge named it; sent back as `pick`.
    let id: String
    let type: String
    let name: String
    let title: String
    let line: String
    let fromText: String
    /// A Spade bot's id.
    let bot: String?
    /// "Never published", "Draft", "1.2.0 is live".
    let state: String
    /// The version it would publish as.
    let version: String
    /// A draft of it already up.
    let draft: String?
}

struct MarketPublishables: Decodable, Equatable {
    let items: [MarketPublishable]
    /// Places that couldn't be read: "Spade isn't running."
    let unavailable: [String]
}

/// What publishing a picked thing would upload, checked on the machine before anything leaves.
struct MarketPublishCheck: Decodable, Equatable {
    struct File: Decodable, Hashable {
        let path: String
        let sizeText: String
        let binary: Bool
    }
    struct LeftOut: Decodable, Hashable {
        let path: String
        let why: String
    }
    struct Finding: Decodable, Identifiable, Hashable {
        let id: Int
        let `where`: String
        let sentence: String
        let blocking: Bool
    }
    struct Bot: Decodable, Equatable {
        struct Routine: Decodable, Identifiable, Hashable {
            let index: Int
            let name: String
            let schedule: String
            let instruction: String
            var id: Int { index }
        }
        struct App: Decodable, Hashable {
            let label: String
            let why: String
            let required: Bool
        }
        struct Effect: Decodable, Hashable {
            let words: String
            let why: String
            let asksEachTime: Bool
        }
        let name: String
        let task: String
        let routines: [Routine]
        let skills: [String]
        let plugins: [String]
        let apps: [App]
        let effects: [Effect]
        let leftOut: [String]
    }
    let hash: String
    let filesText: String
    let files: [File]
    let leftOut: [LeftOut]
    let findings: [Finding]
    let blocking: Int
    let blockingText: String?
    let bot: Bot?
}

/// A draft and ace's checks on its files.
struct MarketPublishDraft: Decodable, Equatable {
    struct Check: Decodable, Identifiable, Hashable {
        let id: String
        /// `pass`, `warn` or `block`.
        let verdict: String
        let sentence: String
        let found: [String]
    }
    let id: String
    let type: String
    let name: String
    let title: String
    let version: String
    let filesText: String
    let scanning: Bool
    let checks: [Check]
    let failing: Int
    let verdictText: String
}
struct MarketPublishDraftAnswer: Decodable { let draft: MarketPublishDraft }

struct MarketPublished: Decodable, Equatable {
    let type: String
    let name: String
    let version: String
    let held: Bool
    /// "Release notes is waiting for review".
    let title: String
    let line: String
    /// The version is in but its listing wasn't saved, in a sentence.
    let listingProblem: String?
}
struct MarketPublishedAnswer: Decodable { let published: MarketPublished }

/// One listing as its publisher manages it.
struct MarketManagedListing: Decodable, Equatable {
    struct Version: Decodable, Identifiable, Hashable {
        let version: String
        let status: String
        let statusText: String
        let dateText: String
        let downloadsText: String
        let reason: String?
        let changelog: String
        let withdrawable: Bool
        var id: String { version }
    }
    struct Signals: Decodable, Equatable {
        struct Report: Decodable, Identifiable, Hashable {
            let id: Int
            let reasonText: String
            let stateText: String
            let dateText: String
        }
        let downloadsText: String
        let adoptionText: String?
        let reports: [Report]
    }
    let id: String
    let type: String
    let name: String
    let title: String
    let line: String
    let typeWord: String
    let statusText: String
    let downloadsText: String
    let reportsText: String?
    let pendingListing: Bool
    let versions: [Version]
    let withdrawable: Bool
    let signals: Signals?
}
struct MarketManagedAnswer: Decodable {
    let listing: MarketManagedListing
    /// After a withdrawal: what it did, in a sentence.
    let message: String?
}
struct MarketProfileAnswer: Decodable { let profile: MarketPublisherProfile }

/// The listing the person writes before Submit.
struct MarketListingWords: Equatable {
    var title = ""
    var line = ""
    var description = ""
    var categories: [String] = []
    var json: [String: Any] {
        ["title": title, "line": line, "description": description, "categories": categories]
    }
}
