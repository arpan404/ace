import Foundation

/// Which list the second tab shows: the web's Pull requests and Issues pages.
enum ForgeKind: String, CaseIterable, Hashable, Sendable {
    case pulls, issues
    var title: String { self == .pulls ? "Pull requests" : "Issues" }
}

/// The Pull requests list's choices, as the web keeps them in its address (`PullsSearch` in
/// `@ace/ui-core`). Nil is the web's default; the bridge turns them into GitHub's search.
struct PullsFilter: Equatable, Sendable {
    var state = "open"
    var who = "all"
    var sort = "ready"
    var draft: String?
    var review: String?
    var checks: String?
    var author: String?
    var labels: [String] = []

    static let states = [("open", "Open"), ("merged", "Merged"), ("closed", "Closed"), ("all", "All")]
    static let involvement = [("all", "Everyone"), ("authored", "Authored"), ("reviewing", "Reviewing")]
    static let sorts = [("ready", "Ready to merge"), ("updated", "Recently updated"), ("largest", "Largest"), ("smallest", "Smallest")]
    static let drafts = [("", "Include drafts"), ("only", "Drafts only"), ("hide", "Hide drafts")]
    static let reviews = [("", "Any review"), ("approved", "Approved"), ("changes", "Changes requested"), ("required", "Review required"), ("none", "No review")]
    static let checkChoices = [("", "Any checks"), ("passing", "Passing"), ("failing", "Failing")]

    /// How many of the Filters menu's narrowing choices are on, for its badge.
    var narrowing: Int { [draft, review, checks, author].compactMap { $0 }.count + labels.count }

    func json(query: String) -> [String: Any] {
        var search: [String: Any] = [:]
        if state != "open" { search["state"] = state }
        if who != "all" { search["who"] = who }
        if sort != "ready" { search["sort"] = sort }
        if let draft { search["draft"] = draft }
        if let review { search["review"] = review }
        if let checks { search["checks"] = checks }
        if let author { search["author"] = author }
        if !labels.isEmpty { search["labels"] = labels }
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { search["q"] = String(trimmed.prefix(256)) }
        return search
    }
}

/// The Issues list's choices (`IssuesSearch` in `@ace/ui-core`).
struct IssuesFilter: Equatable, Sendable {
    var state = "open"
    var who = "all"
    var sort = "updated"
    var author: String?
    var labels: [String] = []

    static let states = [("open", "Open"), ("closed", "Closed")]
    static let involvement = [("all", "Everyone"), ("assigned", "Assigned"), ("created", "Created")]
    static let sorts = [("updated", "Recently updated"), ("created", "Newest"), ("comments", "Most commented")]

    var narrowing: Int { (author == nil ? 0 : 1) + labels.count }

    func json(query: String) -> [String: Any] {
        var search: [String: Any] = [:]
        if state != "open" { search["state"] = state }
        if who != "all" { search["who"] = who }
        if sort != "updated" { search["sort"] = sort }
        if let author { search["author"] = author }
        if !labels.isEmpty { search["labels"] = labels }
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { search["q"] = String(trimmed.prefix(256)) }
        return search
    }
}

/// The project both lists read: the one the inbox chip names, else the last chosen here if it
/// still exists, else the first (the web's `listProject`).
enum ForgeProjectChoice {
    static let key = "ace.forge.project"
    static func pick(chip: String, remembered: String?, projects: [ForgeProject]) -> String? {
        if !chip.isEmpty, projects.contains(where: { $0.id == chip }) { return chip }
        if let remembered, projects.contains(where: { $0.id == remembered }) { return remembered }
        return projects.first?.id
    }
}
