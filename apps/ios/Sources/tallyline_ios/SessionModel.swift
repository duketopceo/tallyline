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
    /// The one session for the app process; Shortcuts reach it here.
    static let shared = SessionModel(store: KeychainCredentialStore())

    private(set) var state: SignInState = .signedOut
    private(set) var lastError: String?

    private let store: any CredentialStore
    /// Issue cache and outbox. Set once in init.
    @ObservationIgnored private(set) var offline: OfflineModel!

    init(store: any CredentialStore) {
        self.store = store
        if let credential = try? store.load() {
            state = .signedIn(credential)
        }
        offline = OfflineModel(client: { [weak self] in self?.client })
    }

    var client: APIClient? {
        guard case let .signedIn(credential) = state else { return nil }
        return APIClient(baseURL: credential.serverURL, bearerToken: credential.token)
    }

    /// Redeem a pairing code against a server URL and sign in on success.
    /// `code` accepts the raw `tlpair_…` or a `tallyline://pair?c=…` URL string.
    /// Each step names itself in `lastError`: a transport failure here used to
    /// land in a generic catch and leave `lastError` nil, so the screen showed
    /// nothing at all while pairing failed.
    func pair(code: String, deviceName: String, serverURL: URL) async throws {
        lastError = nil
        let clean = PairingCode.normalize(code)
        let client = APIClient(baseURL: serverURL)
        let redeemed: PairingRedeemResponse
        do {
            redeemed = try await client.redeemPairingCode(clean, deviceName: deviceName)
        } catch {
            lastError = Self.describe(error, step: "code not accepted")
            throw error
        }
        // The redeem response has no user id; whoami supplies it and proves
        // the new credential works before it is saved.
        let me: Whoami
        do {
            me = try await APIClient(baseURL: serverURL, bearerToken: redeemed.token).whoami()
        } catch {
            lastError = Self.describe(error, step: "new credential rejected")
            throw error
        }
        let credential = DeviceCredential(
            token: redeemed.token,
            expiresAt: redeemed.expiresAt,
            deviceId: redeemed.deviceId,
            userId: me.id ?? "",
            workspaceSlug: redeemed.workspace.slug,
            workspaceName: redeemed.workspace.name,
            serverURL: serverURL
        )
        do {
            try store.save(credential)
        } catch {
            lastError = "could not save the credential: \(error.localizedDescription)"
            throw error
        }
        state = .signedIn(credential)
    }

    /// A refusal the server described, or the transport failure it could not.
    private static func describe(_ error: Error, step: String) -> String {
        if case let APIClientError.http(status, code, message) = error {
            return message ?? "\(step) (\(code ?? "HTTP \(status)"))"
        }
        let reason = (error as? URLError)?.localizedDescription ?? error.localizedDescription
        return "\(step): \(reason)"
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
        WidgetBridge.clear()
        Task { await offline.wipe() }
    }
}
#endif
