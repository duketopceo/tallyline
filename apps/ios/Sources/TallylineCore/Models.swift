import Foundation

/// `POST /v1/auth/pair/redeem` — a redeemed pairing code becomes a device
/// credential (`tly_pat_…`) bound to the member's workspace.
public struct PairingRedeemResponse: Codable, Sendable {
    public let token: String
    public let expiresAt: Date
    public let scopes: [String]
    public let deviceId: String
    /// The API's own base URL, echoed so a QR scan needs no separate server entry.
    public let server: String?
    public let workspace: WorkspaceRef

    public struct WorkspaceRef: Codable, Sendable {
        public let slug: String
        public let name: String
    }
}

/// `POST /v1/workspaces/{ws}/devices/current/rotate` — same credential shape,
/// minus the workspace echo.
public struct DeviceRotateResponse: Codable, Sendable {
    public let token: String
    public let expiresAt: Date
}

/// `GET /v1/whoami` with a human credential (PAT or device token).
public struct Whoami: Codable, Sendable {
    public let type: String
    public let id: String?
    public let name: String?
    public let role: String?
    public let memberships: [Membership]

    public struct Membership: Codable, Sendable {
        public let workspaceSlug: String
        public let role: String
    }
}

/// The API's error envelope: `{ "error": { "code": "…", "message": "…" } }`.
public struct APIErrorEnvelope: Codable, Sendable {
    public let error: APIErrorBody

    public struct APIErrorBody: Codable, Sendable {
        public let code: String
        public let message: String
    }
}

/// The `409 STALE_WRITE` body: the STALE_DIFF shape, an `error` plus the
/// current server issue. Only the version is needed to resolve a conflict.
struct StaleWriteEnvelope: Decodable, Sendable {
    let issue: Current

    struct Current: Decodable, Sendable {
        let version: Int?
    }
}

public enum APIClientError: Error, Equatable, Sendable {
    case http(Int, code: String?, message: String?)
    /// `409 STALE_WRITE`: the issue changed since the version sent in
    /// `If-Match`. Never retry unchanged; carries the server's current version.
    case staleWrite(message: String?, currentVersion: Int?)
    case transport(String)
    case decoding(String)
}
