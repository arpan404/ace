import Foundation
import Security

enum TrustFailure: Error, Equatable { case mismatch, expired, malformed }

/// The only trust decision for ace's HTTPS and WSS: the QR-confirmed SHA-256 DER SPKI pin and
/// the certificate's validity window. One exception (ADR 0097): a Tailscale `*.ts.net` host may
/// present the publicly trusted certificate Tailscale issues for that exact name, whose key
/// changes on every renewal. No other host ever falls back to system trust.
enum PinnedTrust {
    static func verify(certificate: Data, pin: String, now: Date) throws(TrustFailure) {
        let actual: String
        let window: ClosedRange<Date>
        do {
            actual = try CertificatePin.digest(certificate: certificate)
            window = try CertificatePin.validity(certificate: certificate)
        } catch { throw .malformed }
        guard isPin(pin), actual == pin.lowercased() else { throw .mismatch }
        guard now >= window.lowerBound, now < window.upperBound else { throw .expired }
    }
    /// Evaluate a server-trust challenge for `host`. Returns the credential to use, or the failure.
    static func evaluate(_ challenge: URLAuthenticationChallenge, host: String?, pin: String?, now: Date) -> Result<URLCredential, TrustFailure> {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let host, challenge.protectionSpace.host == host,
              let trust = challenge.protectionSpace.serverTrust,
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else {
            return .failure(.malformed)
        }
        do throws(TrustFailure) {
            try decide(certificate: SecCertificateCopyData(leaf) as Data, pin: pin, host: host, now: now) {
                SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString))
                return SecTrustEvaluateWithError(trust, nil)
            }
        } catch { return .failure(error) }
        return .success(URLCredential(trust: trust))
    }
    /// The exact pinned key authenticates ace's self-signed certificate. When it doesn't match,
    /// only a ts.net host may still pass, and only if the system trusts its chain for that name.
    static func decide(certificate: Data, pin: String?, host: String, now: Date, systemTrusts: () -> Bool) throws(TrustFailure) {
        do throws(TrustFailure) {
            try verify(certificate: certificate, pin: pin ?? "", now: now)
        } catch {
            guard error == .mismatch, isTailnetName(host), systemTrusts() else { throw error }
        }
    }
    /// A Tailscale MagicDNS name: only that machine can get a public certificate for it.
    static func isTailnetName(_ host: String) -> Bool {
        var name = host.lowercased()
        if name.hasSuffix(".") { name.removeLast() }
        return name.hasSuffix(".ts.net") && name.count > ".ts.net".count
    }
    static func isPin(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
    }
}
