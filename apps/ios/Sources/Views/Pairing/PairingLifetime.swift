import Foundation

/// Permission callbacks belong only to the appearance that requested them.
struct PairingLifetime {
    private var generation = 0
    private var active = false
    mutating func enter() -> Int { generation += 1; active = true; return generation }
    mutating func leave() { active = false; generation += 1 }
    var acceptsCurrent: Bool { active }
    func accepts(_ token: Int) -> Bool { active && generation == token }
}

func pairingDeviceName(_ name: String) -> String {
    var result = ""
    for scalar in name.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars {
        guard result.utf16.count + scalar.utf16.count <= 256 else { break }
        result.unicodeScalars.append(scalar)
    }
    return result
}
