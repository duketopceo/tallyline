import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Thin REST client for the Tallyline `/v1` surface. The bearer credential is a
/// `tly_pat_` device token from pairing (OAuth tokens are audience-bound to
/// `/mcp` and cannot call `/v1`).
public struct APIClient: Sendable {
    public let baseURL: URL
    public var bearerToken: String?

    private let session: URLSession
    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    public init(baseURL: URL, bearerToken: String? = nil, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.bearerToken = bearerToken
        self.session = session
    }

    /// Absolute URL for an API path such as `/v1/whoami`, preserving any path
    /// the instance URL already carries (self-hosted subpath installs).
    public func url(for path: String, query: [String: String] = [:]) -> URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        let basePath = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        components.path = basePath + path
        components.queryItems = query.isEmpty ? nil : query.map { URLQueryItem(name: $0.key, value: $0.value) }
        return components.url!
    }

    /// Redeem a `tlpair_…` code for a device credential. Public endpoint —
    /// no bearer token required.
    public func redeemPairingCode(_ code: String, deviceName: String, platform: String = "ios") async throws -> PairingRedeemResponse {
        struct Body: Encodable { let code: String; let deviceName: String; let platform: String }
        return try await send(
            method: "POST",
            path: "/v1/auth/pair/redeem",
            body: Body(code: code, deviceName: deviceName, platform: platform),
            authorized: false
        )
    }

    /// Rotate the current device credential; the old token dies on a schedule
    /// the server returns. Call near expiry or on a schedule.
    public func rotateDeviceToken(workspaceSlug: String) async throws -> DeviceRotateResponse {
        struct Body: Encodable {}
        return try await send(
            method: "POST",
            path: "/v1/workspaces/\(workspaceSlug)/devices/current/rotate",
            body: Body()
        )
    }

    /// `GET /v1/whoami` — validates the credential and returns the caller's
    /// memberships, used to pick the active workspace.
    public func whoami() async throws -> Whoami {
        try await send(method: "GET", path: "/v1/whoami")
    }

    public func send<Out: Decodable>(
        method: String,
        path: String,
        query: [String: String] = [:],
        authorized: Bool = true,
        idempotencyKey: String? = nil
    ) async throws -> Out {
        try await sendRaw(method: method, path: path, query: query, body: nil as Data?, authorized: authorized, idempotencyKey: idempotencyKey)
    }

    public func send<In: Encodable, Out: Decodable>(
        method: String,
        path: String,
        query: [String: String] = [:],
        body: In,
        authorized: Bool = true,
        idempotencyKey: String? = nil
    ) async throws -> Out {
        let data = try JSONEncoder().encode(body)
        return try await sendRaw(method: method, path: path, query: query, body: data, authorized: authorized, idempotencyKey: idempotencyKey)
    }

    private func sendRaw<Out: Decodable>(
        method: String,
        path: String,
        query: [String: String],
        body: Data?,
        authorized: Bool,
        idempotencyKey: String?
    ) async throws -> Out {
        var request = URLRequest(url: url(for: path, query: query))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let idempotencyKey {
            request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        }
        if body != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        if authorized, let bearerToken {
            request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        }
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIClientError.transport(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(status) else {
            let envelope = try? Self.decoder.decode(APIErrorEnvelope.self, from: data)
            throw APIClientError.http(status, code: envelope?.error.code, message: envelope?.error.message)
        }
        do {
            return try Self.decoder.decode(Out.self, from: data)
        } catch {
            throw APIClientError.decoding(String(describing: error))
        }
    }
}
