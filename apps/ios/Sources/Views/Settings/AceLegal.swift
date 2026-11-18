import Foundation

/// The pages ace's site publishes for the app: terms, privacy and support. Settings, Profile and
/// Settings' search all open these in the system browser, so each URL lives here once.
enum AceLegal {
    struct Page: Identifiable, Equatable {
        let id: String
        let title: String
        let symbol: String
        let url: URL
        /// Other words people search for it by.
        let keywords: [String]
    }

    static let terms = Page(id: "terms", title: "Terms of service", symbol: "doc.plaintext",
                            url: URL(string: "https://acehq.dev/terms-of-service/")!, keywords: ["legal", "agreement"])
    static let privacy = Page(id: "privacy", title: "Privacy policy", symbol: "hand.raised",
                              url: URL(string: "https://acehq.dev/privacy-policy/")!, keywords: ["legal", "data"])
    /// Terms of service and Privacy policy, the pages Profile links to.
    static let policies = [terms, privacy]
    static let support = Page(id: "support", title: "Support", symbol: "questionmark.circle",
                              url: URL(string: "https://acehq.dev/support/")!, keywords: ["help", "contact"])
    static let all = policies + [support]
}
