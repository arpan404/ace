import Foundation

/// Window numbers the model can rely on: a window keeps the number it got when first seen
/// for as long as it exists, whatever order the app lists its windows in. A new window takes
/// the lowest number no live window holds.
struct CUWindowNumbering<Key: Hashable> {
    private var numbers: [Key: Int] = [:]

    /// Numbers for `keys` (in the same order). Keys missing from `keys` are forgotten.
    mutating func assign(_ keys: [Key]) -> [Int] {
        let live = Set(keys)
        numbers = numbers.filter { live.contains($0.key) }
        var used = Set(numbers.values)
        return keys.map { key in
            if let number = numbers[key] { return number }
            var number = 1
            while used.contains(number) { number += 1 }
            used.insert(number)
            numbers[key] = number
            return number
        }
    }
}

/// Which window to make key before keyboard and click steps. A dialog, sheet or panel the
/// app focused on top of the chosen window (or any window it opened after it) is where keys
/// must go; otherwise the chosen window.
struct CUKeyWindowFacts: Equatable {
    let chosen: UInt32
    let focused: UInt32?
    let focusedSubrole: String?
    let focusedRole: String?
}

func cuKeyWindowTarget(_ facts: CUKeyWindowFacts) -> UInt32 {
    guard let focused = facts.focused, focused != facts.chosen else { return facts.chosen }
    let dialog = ["AXDialog", "AXSystemDialog", "AXFloatingWindow", "AXSystemFloatingWindow"].contains(facts.focusedSubrole ?? "")
        || facts.focusedRole == "AXSheet"
    // Window server ids grow over a session, so a larger id is a window opened later.
    return dialog || focused > facts.chosen ? focused : facts.chosen
}
