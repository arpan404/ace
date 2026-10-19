import Foundation
import Security

enum TrustFailure: Error, Equatable { case mismatch, expired, malformed }

/// The only trust decision for ace's HTTPS and WSS: the QR-confirmed SHA-256 DER SPKI pin and
/// the certificate's validity window. There is no CA, hostname or system-trust fallback.
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
        guard let pin else { return .failure(.mismatch) }
        do throws(TrustFailure) {
            try verify(certificate: SecCertificateCopyData(leaf) as Data, pin: pin, now: now)
        } catch { return .failure(error) }
        // The exact public key authenticates the daemon's self-signed certificate.
        return .success(URLCredential(trust: trust))
    }
    static func isPin(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
    }
}
