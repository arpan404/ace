import Foundation

/// Media the daemon fetched for GitHub text, kept while the app runs so a page redrawn or opened
/// again shows it at once. Bytes only ever come from the daemon (ADR 0096).
@MainActor final class ForgeMediaCache {
    static let shared = ForgeMediaCache()
    private let cache = NSCache<NSString, Box>()
    final class Box { let value: ForgeMediaBytes; init(_ value: ForgeMediaBytes) { self.value = value } }
    init() { cache.totalCostLimit = 96 << 20 }

    func load(_ url: String, role: String, scope: ForgeRichScope) async -> ForgeMediaBytes? {
        let key = "\(scope.project)|\(role)|\(url)" as NSString
        if let kept = cache.object(forKey: key) { return kept.value }
        guard let value = await scope.media(url, role: role) else { return nil }
        // Only answers that won't change are kept; a failure is asked again next time.
        if value.state != "unavailable" { cache.setObject(Box(value), forKey: key, cost: value.data?.utf8.count ?? 64) }
        return value
    }
}
