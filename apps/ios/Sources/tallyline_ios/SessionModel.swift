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
    /// The signed-in person, for the profile button and Settings.
    private(set) var me: Whoami?

    func loadMe() async {
        guard me == nil, let client else { return }
        me = try? await client.whoami()
    }

    func clearError() { lastError = nil }
    func setError(_ message: String) { lastError = message }

    private let store: any CredentialStore
    /// Credentials for other workspaces this phone is paired with. A device
    /// credential is bound to one workspace, so switching swaps credentials.
    private let shelf: CredentialShelf
    /// Issue cache and outbox. Set once in init.
    @ObservationIgnored private(set) var offline: OfflineModel!
    /// Roadmap summary, review queue and pick-lists, shared by every tab.
    let workspace = WorkspaceModel()

    /// One sync cycle: issue delta, then the shared workspace data.
    func refresh() async {
        guard case let .signedIn(credential) = state else { return }
        try? await offline.syncIssues(workspaceSlug: credential.workspaceSlug)
        await workspace.refresh(client: client, workspaceSlug: credential.workspaceSlug)
    }

    init(
        store: any CredentialStore,
        shelf: CredentialShelf = CredentialShelf(index: JSONFileStore<[String]>.standard(named: "workspace-shelf")) { slug in
            KeychainCredentialStore(account: "workspace-\(slug)")
        }
    ) {
        self.store = store
        self.shelf = shelf
        if let credential = try? store.load() {
            state = .signedIn(credential)
        }
        offline = OfflineModel(client: { [weak self] in self?.client })
        if case let .signedIn(credential) = state { offline.activate(workspaceSlug: credential.workspaceSlug) }
    }

    /// The workspaces to offer in Settings. Empty (so no row at all) unless
    /// the person belongs to more than one.
    var workspaceChoices: [WorkspaceChoice] {
        guard case let .signedIn(credential) = state, let me else { return [] }
        return WorkspaceSwitcher.choices(memberships: me.memberships, current: credential.workspaceSlug, pairedSlugs: shelf.shelvedSlugs)
    }

    /// Make a paired workspace the active one: its credential, its cache, its
    /// queued writes. Returns false (and says why in `lastError`) when this
    /// phone is not paired with it or its credential has lapsed.
    @discardableResult
    func switchWorkspace(to slug: String) -> Bool {
        lastError = nil
        guard case let .signedIn(current) = state, current.workspaceSlug != slug else { return false }
        guard let next = try? shelf.take(slug) else {
            lastError = "This phone is not paired with that workspace yet."
            return false
        }
        guard next.expiresAt > Date() else {
            lastError = "Access to that workspace has expired. Pair this phone with it again."
            return false
        }
        do {
            try shelf.shelve(current)
            try store.save(next)
        } catch {
            // Put things back the way they were.
            _ = try? shelf.take(current.workspaceSlug)
            try? shelf.shelve(next)
            lastError = "Could not switch workspaces: \(error.localizedDescription)"
            return false
        }
        enter(next)
        return true
    }

    /// Show a different workspace: reset what is scoped to the old one.
    private func enter(_ credential: DeviceCredential) {
        me = nil
        workspace.reset()
        offline.activate(workspaceSlug: credential.workspaceSlug)
        state = .signedIn(credential)
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
        try await finishSignIn(redeemed: redeemed, serverURL: serverURL)
    }

    /// Cloud Sign in with Apple → same device PAT as pairing.
    func signInWithApple(identityToken: String, rawNonce: String, deviceName: String, serverURL: URL = TallylineConfig.defaultServerURL) async throws {
        lastError = nil
        let client = APIClient(baseURL: serverURL)
        let redeemed: PairingRedeemResponse
        do {
            redeemed = try await client.signInWithApple(
                identityToken: identityToken,
                rawNonce: rawNonce,
                deviceName: deviceName
            )
        } catch {
            lastError = Self.describe(error, step: "Apple sign-in not accepted")
            throw error
        }
        try await finishSignIn(redeemed: redeemed, serverURL: serverURL)
    }

    private func finishSignIn(redeemed: PairingRedeemResponse, serverURL: URL) async throws {
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
        // Pairing a second workspace keeps the first one's credential on the
        // shelf instead of dropping it, so Settings can switch back.
        var previous: DeviceCredential?
        if case let .signedIn(old) = state, old.workspaceSlug != credential.workspaceSlug { previous = old }
        do {
            if let previous { try shelf.shelve(previous) }
            _ = try shelf.take(credential.workspaceSlug)
            try store.save(credential)
        } catch {
            lastError = "could not save the credential: \(error.localizedDescription)"
            throw error
        }
        enter(credential)
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

    /// Rotate the credential now, whatever its age. Returns false on failure.
    @discardableResult
    func rotateNow() async -> Bool {
        guard case let .signedIn(credential) = state, let client else { return false }
        do {
            let rotated = try await client.rotateDeviceToken(workspaceSlug: credential.workspaceSlug)
            var updated = credential
            updated.token = rotated.token
            updated.expiresAt = rotated.expiresAt
            try store.save(updated)
            state = .signedIn(updated)
            return true
        } catch {
            return false
        }
    }

    func signOut() {
        me = nil
        workspace.reset()
        try? store.clear()
        shelf.clear()
        state = .signedOut
        WidgetBridge.clear()
        Task { await offline.wipe() }
    }
}
#endif
