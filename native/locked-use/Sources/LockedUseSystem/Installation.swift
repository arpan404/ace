import Foundation
import Security

/// On-disk and loaded facts the owner gathers before the feature can be enabled. Every
/// field defaults to false; there is no constructor that assumes a verified install.
public struct LockedUseInstallationFacts: Equatable, Sendable {
    public var pluginSigned = false
    public var ruleReachesMechanism = false
    public var lockOnDisplaySleep = false
    public var brokerLinked = false
    public var guardianLinked = false

    public init(pluginSigned: Bool = false, ruleReachesMechanism: Bool = false, lockOnDisplaySleep: Bool = false,
                brokerLinked: Bool = false, guardianLinked: Bool = false) {
        self.pluginSigned = pluginSigned
        self.ruleReachesMechanism = ruleReachesMechanism
        self.lockOnDisplaySleep = lockOnDisplaySleep
        self.brokerLinked = brokerLinked
        self.guardianLinked = guardianLinked
    }

    public var verified: Bool { pluginSigned && ruleReachesMechanism && lockOnDisplaySleep && brokerLinked && guardianLinked }
}

/// True if satisfying `mechanism` alone can satisfy `right`, read the way authd evaluates
/// rights. Pure: `lookup` supplies authorization-database definitions read elsewhere.
///
/// - `class evaluate-mechanisms`: reaches when its `mechanisms` list contains `mechanism`.
/// - `class rule`: follows the names in `rule` (up to `depth` levels and 16 names). A
///   `mechanisms` key on a rule-class right is ignored, as authd ignores it. A named branch
///   counts only if it alone satisfies the rule: `k-of-n` is 1, or it is the only name. An
///   absent `k-of-n` means every name must succeed, so with several names it does not count.
/// - Any other or missing class never reaches.
///
/// The installed shape is `system.login.screensaver` = `class rule`, `k-of-n` 1, with
/// `dev.ace.locked-use.permit` in its `rule` list, and that right = `class
/// evaluate-mechanisms` with `AceLockedUseAuthorization:permit`.
public func lockedUseRuleReaches(_ mechanism: String, from right: String, depth: Int = 3,
                                 lookup: (String) -> [String: Any]?) -> Bool {
    guard depth > 0, let definition = lookup(right), let kind = definition["class"] as? String else { return false }
    switch kind {
    case "evaluate-mechanisms":
        return (definition["mechanisms"] as? [String])?.contains(mechanism) ?? false
    case "rule":
        let rules = (definition["rule"] as? [String]) ?? (definition["rule"] as? String).map { [$0] } ?? []
        let required = lockedUseAuthorizationInteger(definition["k-of-n"]) ?? 0
        guard required == 1 || (rules.count == 1 && required == 0) else { return false }
        return rules.prefix(16).contains { lockedUseRuleReaches(mechanism, from: $0, depth: depth - 1, lookup: lookup) }
    default:
        return false
    }
}

/// Integers only: a boolean bridged to NSNumber is not a count.
private func lockedUseAuthorizationInteger(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    return Int(exactly: number.doubleValue)
}

/// Parses `sysadminctl -screenLock status`. Only an immediate delay counts: any delay
/// would let the desktop stay open after a relock request.
public func lockedUseScreenLockIsImmediate(_ output: String) -> Bool {
    output.split(whereSeparator: \.isNewline).contains { $0.hasSuffix("screenLock delay is immediate") }
}

/// Read-only probes of the installed plug-in, authorization rule and screen-lock setting.
/// None of these writes the authorization database or changes any security setting.
public enum LockedUseInstallationProbe {
    public static func pluginSigned(path: String = LockedUseNames.pluginPath, team: String) -> Bool {
        guard FileManager.default.fileExists(atPath: path) else { return false }
        var code: SecStaticCode?
        var requirement: SecRequirement?
        let text = "anchor apple generic and certificate leaf[subject.OU] = \"\(team)\" and identifier \"dev.ace.locked-use.authorization-plugin\""
        guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &code) == errSecSuccess, let code,
              SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess, let requirement else { return false }
        return SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSCheckAllArchitectures), requirement) == errSecSuccess
    }

    public static func ruleReachesMechanism() -> Bool {
        lockedUseRuleReaches(LockedUseNames.pluginMechanism, from: lockedUseScreensaverRight) { name in
            var definition: CFDictionary?
            guard AuthorizationRightGet(name, &definition) == errAuthorizationSuccess else { return nil }
            return definition as? [String: Any]
        }
    }

    public static func lockOnDisplaySleep() -> Bool {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/sysadminctl")
        process.arguments = ["-screenLock", "status"]
        process.standardOutput = pipe
        process.standardError = pipe
        guard (try? process.run()) != nil else { return false }
        let data = pipe.fileHandleForReading.readDataToEndOfFile().prefix(4096)
        process.waitUntilExit()
        return process.terminationStatus == 0 && lockedUseScreenLockIsImmediate(String(decoding: data, as: UTF8.self))
    }
}
