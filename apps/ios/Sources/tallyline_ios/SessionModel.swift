#if os(iOS)
import Foundation
import Observation
import TallylineCore

/// Sign-in lifecycle: unpaired → pairing → paired. A revoked or expired device
/// falls back to the instance picker with its workspace remembered.
enum SignInState {
    case signedOut
    case signedIn(DeviceCredential)
}

/// Owns the device credential and the API client built from it. Views observe
/// this; the Keychain store is injected at app start.
@MainActor @Observable
final class SessionModel {
    private(set) var state: SignInState = .signedOut
    private(set) var lastError: String?

    private let store: any CredentialStore

    init(store: any CredentialStore) {
        self.store = store
        if let credential = try? store.load() {
            state = .signedIn(credential)
        }
    }

    var client: APIClient? {
        guard case let .signedIn(credential) = state else { return nil }
        return APIClient(baseURL: credential.serverURL, bearerToken: credential.token)
    }

    /// Redeem a pairing code against a server URL and sign in on success.
    /// `code` accepts the raw `tlpair_…` or a `tallyline://pair?c=…` URL string.
    func pair(code: String, deviceName: String, serverURL: URL) async throws {
        lastError = nil
        let clean = PairingCode.normalize(code)
        let client = APIClient(baseURL: serverURL)
        do {
            let redeemed = try await client.redeemPairingCode(clean, deviceName: deviceName)
            let credential = DeviceCredential(
                token: redeemed.token,
                expiresAt: redeemed.expiresAt,
                deviceId: redeemed.deviceId,
                userId: redeemed.userId,
                workspaceSlug: redeemed.workspace.slug,
                workspaceName: redeemed.workspace.name,
                serverURL: serverURL
            )
            try store.save(credential)
            state = .signedIn(credential)
        } catch let APIClientError.http(status, code, message) {
            lastError = message ?? "pairing failed (\(code ?? "HTTP \(status)"))"
            throw APIClientError.http(status, code: code, message: message)
        }
    }

    /// Rotate the credential when it nears expiry. A failed rotation signs out
    /// only on 401 — transient errors leave the session for a retry.
    func rotateIfNeeded() async {
        guard case let .signedIn(credential) = state, credential.needsRotation() else { return }
        guard let client else { return }
        do {
            let rotated = try await client.rotateDeviceToken(workspaceSlug: credential.workspaceSlug)
            var updated = credential
            updated.token = rotated.token
            updated.expiresAt = rotated.expiresAt
            try store.save(updated)
            state = .signedIn(updated)
        } catch let APIClientError.http(status, _, _) where status == 401 {
            try? store.clear()
            state = .signedOut
        } catch {
            // transient — the next launch retries
        }
    }

    func signOut() {
        try? store.clear()
        state = .signedOut
    }
}
#endif
