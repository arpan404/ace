import Foundation
import Security

public enum LockedUseSigningError: Error, Equatable { case unsigned, invalidTeam }

/// Builds a peer code-signing requirement pinned to this executable's own Developer ID team.
/// An unsigned or ad-hoc signed executable has no team, so privileged listeners refuse to start.
public func lockedUsePeerRequirement(identifier: String) throws -> String {
    try lockedUsePeerRequirement(identifier: identifier, team: lockedUseOwnTeam())
}

/// This executable's Developer ID team. Throws for unsigned or ad-hoc signed code.
public func lockedUseOwnTeam() throws -> String {
    var code: SecCode?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { throw LockedUseSigningError.unsigned }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { throw LockedUseSigningError.unsigned }
    var info: CFDictionary?
    guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let values = info as? [String: Any], let team = values[kSecCodeInfoTeamIdentifier as String] as? String else {
        throw LockedUseSigningError.unsigned
    }
    return team
}

public func lockedUsePeerRequirement(identifier: String, team: String) throws -> String {
    guard team.count == 10, team.allSatisfy({ $0.isASCII && ($0.isUppercase || $0.isNumber) }) else {
        throw LockedUseSigningError.invalidTeam
    }
    guard !identifier.isEmpty, identifier.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || ".-".contains($0)) }) else {
        throw LockedUseSigningError.invalidTeam
    }
    return "anchor apple generic and certificate leaf[subject.OU] = \"\(team)\" and identifier \"\(identifier)\""
}

/// Mach service names and signing identifiers shared by the service, broker and guardian.
public enum LockedUseNames {
    public static let authorizationService = "dev.ace.locked-use.authorization"
    public static let brokerService = "dev.ace.locked-use.broker"
    public static let guardianService = "dev.ace.locked-use.guardian"
    /// The GUI-session service runs inside the signed screen helper (`--locked-use`).
    public static let serviceIdentifier = "dev.ace.screen-helper"
    public static let authorityIdentifier = "dev.ace.locked-use.authority"
    public static let guardianIdentifier = "dev.ace.locked-use.guardian"
    public static let pluginMechanism = "AceLockedUseAuthorization:permit"
    public static let pluginPath = "/Library/Security/SecurityAgentPlugins/AceLockedUseAuthorization.bundle"
}
