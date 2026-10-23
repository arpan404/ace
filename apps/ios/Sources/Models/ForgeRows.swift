import Foundation

/// What `bridge/forge-*.ts` sends for the Pull requests and Issues screens. Every word, tone and
/// step is the web's shared rule's (`@ace/ui-core`); Swift lays them out and derives nothing.
struct ForgeMark: Decodable, Sendable, Equatable {
    let word: String
    let tone: String
}

struct ForgeLabel: Decodable, Sendable, Equatable, Hashable {
    let name: String
    /// GitHub's colour as six hex digits.
    let color: String?
}

/// A repository on a forge, echoed back unchanged when the phone asks about one of its items.
struct ForgeRepository: Codable, Sendable, Equatable, Hashable {
    let forge: String
    let host: String
    let owner: String
    let name: String
    var json: [String: Any] { ["forge": forge, "host": host, "owner": owner, "name": name] }
}

struct ForgeThreadLink: Decodable, Sendable, Equatable {
    let id: String
    let title: String
    let needsYou: Bool
}

struct ForgePullRow: Decodable, Sendable, Equatable, Identifiable {
    let key: String
    let number: Int
    let repository: ForgeRepository
    let title: String
    let url: String
    let state: ForgeMark
    let merged: Bool
    let conflicting: Bool
    let labels: [ForgeLabel]
    let review: ForgeMark?
    let checks: ForgeMark?
    let comments: Int
    let additions: Int?
    let deletions: Int?
    let author: String
    let branches: String?
    let thread: ForgeThreadLink?
    let step: String?
    let stepNeedsYou: Bool
    let quiet: String?
    let updatedAt: Double?
    var id: String { key }
}

struct ForgeIssueRow: Decodable, Sendable, Equatable, Identifiable {
    let key: String
    let number: Int
    let repository: ForgeRepository
    let title: String
    let url: String
    let state: ForgeMark
    let labels: [ForgeLabel]
    let comments: Int
    let assignees: [String]
    let author: String
    let milestone: String?
    let thread: ForgeThreadLink?
    let updatedAt: Double?
    var id: String { key }
}

struct ForgeGroup<Row: Decodable & Sendable & Equatable>: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let label: String
    /// GitHub's total for the group once known.
    let count: Int?
    let rows: [Row]
}

struct ForgePullCounts: Decodable, Sendable, Equatable { let open: Int; let merged: Int; let closed: Int }
struct ForgeIssueCounts: Decodable, Sendable, Equatable { let open: Int; let closed: Int }

struct ForgePullList: Decodable, Sendable, Equatable {
    let repository: String
    let counts: ForgePullCounts?
    let groups: [ForgeGroup<ForgePullRow>]
    let more: Bool
    let authors: [String]
    let labels: [String]
}

struct ForgeIssueList: Decodable, Sendable, Equatable {
    let repository: String
    let counts: ForgeIssueCounts?
    let groups: [ForgeGroup<ForgeIssueRow>]
    let more: Bool
    let authors: [String]
    let labels: [String]
    let canCreate: Bool
}

struct ForgeProject: Decodable, Sendable, Equatable, Identifiable { let id: String; let name: String }
struct ForgeProjects: Decodable, Sendable { let projects: [ForgeProject] }

/// A merge or auto-merge's outcome, refused or not, in the web's words.
struct ForgeWrite: Decodable, Sendable, Equatable { let ok: Bool; let message: String }
