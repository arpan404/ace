import Foundation

/// Display-only previews in UTF-16 budgets. Opaque identities never pass through this adapter.
enum DisplayText {
    static func head(_ text: String, limit: Int) -> String {
        let source = text as NSString
        guard limit > 0 else { return "" }
        guard source.length > limit else { return repaired(text) }
        let cluster = source.rangeOfComposedCharacterSequence(at: limit - 1)
        let end = NSMaxRange(cluster) > limit ? cluster.location : limit
        return repaired(source.substring(to: end)) + "…"
    }
    static func tail(_ text: String, limit: Int) -> String {
        let source = text as NSString
        guard limit > 0 else { return "" }
        guard source.length > limit else { return repaired(text) }
        let proposed = source.length - limit
        let cluster = source.rangeOfComposedCharacterSequence(at: proposed)
        let start = cluster.location < proposed ? NSMaxRange(cluster) : proposed
        return repaired(source.substring(from: start))
    }
    private static func repaired(_ text: String) -> String {
        // JSC can supply a foreign NSString with unpaired UTF-16 even when no
        // truncation is needed. Re-decode the bounded preview before returning it.
        String(decoding: text.utf16, as: UTF16.self)
    }
}
