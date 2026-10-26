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

/// True if `right` (or a rule it names, up to `depth` levels) evaluates `mechanism`.
/// Pure: `lookup` supplies authorization-database definitions read elsewhere.
public func lockedUseRuleReaches(_ mechanism: String, from right: String, depth: Int = 3,
                                 lookup: (String) -> [String: Any]?) -> Bool {
    guard depth > 0, let definition = lookup(right) else { return false }
    if let mechanisms = definition["mechanisms"] as? [String], mechanisms.contains(mechanism) { return true }
    let rules = (definition["rule"] as? [String]) ?? (definition["rule"] as? String).map { [$0] } ?? []
    return rules.prefix(16).contains { lockedUseRuleReaches(mechanism, from: $0, depth: depth - 1, lookup: lookup) }
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
