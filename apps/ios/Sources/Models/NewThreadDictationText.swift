import Foundation

/// The words while dictating: what was written before the mic was tapped, then what has been
/// heard so far, separated the way the person would have typed it. Pure.
enum DictationText {
    static func join(_ before: String, heard: String) -> String {
        let spoken = heard.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !spoken.isEmpty else { return before }
        if before.isEmpty { return spoken }
        if before.hasSuffix(" ") || before.hasSuffix("\n") { return before + spoken }
        return before + " " + spoken
    }
}
