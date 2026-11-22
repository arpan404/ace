import Foundation

/// Redeeming a pairing link, done natively (ADR 0190 §7): the code and the standing key's public
/// half go to the machine from here, over pinned HTTPS, so the script never holds the code and
/// can't name a key of its own. The bridge gets only the machine's answer (`answer`), from which
/// it reads the device and token as before.
enum PairingRedemption {
    private struct Body: Encodable { let code: String; let name: String; let installId: String?; let standingKey: String? }

    /// `POST /v1/pair`: the code in the body only, never in a URL; no bearer token.
    static func request(code: String, name: String, installId: String?, standingKey: String?) throws -> PinnedHTTPRequest {
        let body = try JSONEncoder().encode(Body(code: code, name: name, installId: installId, standingKey: standingKey))
        return PinnedHTTPRequest(method: "POST", path: "/v1/pair", body: String(decoding: body, as: UTF8.self), token: nil)
    }

    /// What the bridge is handed (`redeemed`): the machine's status and body, or why the pinned
    /// transport refused the request.
    static func answer(_ result: Result<PinnedHTTPResponse, PinnedHTTPError>) -> [String: Any] {
        switch result {
        case .success(let response): ["status": response.status, "body": response.body]
        case .failure(let reason): ["refused": reason.rawValue]
        }
    }

    /// Sends `request` to the link's machine, which must present the link's pinned key.
    static func send(_ request: PinnedHTTPRequest, to link: PairingLink) async -> Result<PinnedHTTPResponse, PinnedHTTPError> {
        guard let origin = ConnectionTarget.pairing(endpoint: link.socketURL, pin: link.fingerprint).httpsOrigin else { return .failure(.invalid) }
        return await withCheckedContinuation { continuation in
            PinnedHTTP.send(origin: origin, pin: link.fingerprint, request: request) { continuation.resume(returning: $0) }
        }
    }
}
