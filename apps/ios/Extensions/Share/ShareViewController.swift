import SwiftUI
import UIKit
import UniformTypeIdentifiers
import TallylineCore
import TallylineDesign

/// Share sheet entry point: "Tallyline" in another app's share menu files the
/// link or text as a triage issue. It sends straight away when online and
/// otherwise leaves the issue in the App Group inbox for the app's outbox.
@objc(ShareViewController)
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        let model = ShareModel(
            items: items,
            done: { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) },
            cancel: { [weak self] in
                self?.extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
            }
        )
        let host = UIHostingController(rootView: ShareView(model: model))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }
}

@MainActor @Observable
final class ShareModel {
    enum Phase: Equatable {
        case loading
        case ready
        case signedOut
        case nothingToShare
        case sending
        case finished(String)
        case failed(String)
    }

    var phase: Phase = .loading
    var title = ""
    var notes = ""
    var teamId = ""
    private(set) var teams: [Team] = []
    private(set) var workspaceName = ""

    private let items: [NSExtensionItem]
    private let done: () -> Void
    private let cancelAction: () -> Void
    private var credential: DeviceCredential?
    private var sharedURL: URL?
    private let memory = TeamMemory()

    init(items: [NSExtensionItem], done: @escaping () -> Void, cancel: @escaping () -> Void) {
        self.items = items
        self.done = done
        self.cancelAction = cancel
    }

    func load() async {
        guard let credential = try? KeychainCredentialStore().load() else {
            phase = .signedOut
            return
        }
        self.credential = credential
        workspaceName = credential.workspaceName

        let (text, url) = await Self.extract(items)
        sharedURL = url
        teams = memory.teams
        teamId = memory.pick(from: teams)?.id ?? memory.teamId ?? ""
        guard let draft = ShareComposer.draft(text: text, url: url, teamId: teamId) else {
            phase = .nothingToShare
            return
        }
        title = draft.title
        notes = draft.description ?? ""
        phase = .ready

        // Fresh teams if we are online; the cached list covers offline.
        let client = APIClient(baseURL: credential.serverURL, bearerToken: credential.token)
        if let fresh = try? await client.teams(ws: credential.workspaceSlug), !fresh.isEmpty {
            teams = fresh
            memory.teams = fresh
            if !fresh.contains(where: { $0.id == teamId }) { teamId = memory.pick(from: fresh)?.id ?? "" }
        }
    }

    var canSend: Bool {
        phase == .ready && !title.trimmingCharacters(in: .whitespaces).isEmpty && !teamId.isEmpty
    }

    func send() async {
        guard let credential, canSend else { return }
        phase = .sending
        memory.teamId = teamId
        let body = notes.trimmingCharacters(in: .whitespacesAndNewlines)
        let draft = IssueCreate(
            title: title.trimmingCharacters(in: .whitespaces),
            description: body.isEmpty ? nil : body,
            teamId: teamId,
            state: .triage
        )
        let item = SharedDraft(workspaceSlug: credential.workspaceSlug, draft: draft)
        let client = APIClient(baseURL: credential.serverURL, bearerToken: credential.token)
        do {
            let issue = try await client.createIssue(ws: credential.workspaceSlug, draft, idempotencyKey: item.id)
            finish("Added \(issue.key) to triage")
        } catch {
            switch OutboxFailure.classify(error) {
            case .retryable:
                // Offline or the server is busy: the app's outbox sends it
                // later with the same idempotency key.
                if let inbox = ShareInbox.shared(), (try? inbox.add(item)) != nil {
                    finish("Saved. It sends next time you open Tallyline.")
                } else {
                    phase = .failed("Could not save on this phone.")
                }
            case .rejected(let reason):
                phase = .failed(reason)
            }
        }
    }

    func cancel() {
        cancelAction()
    }

    private func finish(_ message: String) {
        phase = .finished(message)
        Task {
            try? await Task.sleep(for: .seconds(1.2))
            done()
        }
    }

    /// The first URL and all text the host app attached.
    static func extract(_ items: [NSExtensionItem]) async -> (String?, URL?) {
        var texts: [String] = []
        var url: URL?
        for item in items {
            if let content = item.attributedContentText?.string, !content.isEmpty { texts.append(content) }
            for provider in item.attachments ?? [] {
                if url == nil, provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    url = await loadURL(provider)
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    if let text = await loadText(provider), !texts.contains(text) { texts.append(text) }
                }
            }
        }
        let text = texts.joined(separator: "\n")
        return (text.isEmpty ? nil : text, url)
    }

    private static func loadURL(_ provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { continuation in
            _ = provider.loadObject(ofClass: URL.self) { value, _ in
                continuation.resume(returning: value)
            }
        }
    }

    private static func loadText(_ provider: NSItemProvider) async -> String? {
        await withCheckedContinuation { continuation in
            _ = provider.loadObject(ofClass: String.self) { value, _ in
                continuation.resume(returning: value)
            }
        }
    }
}

struct ShareView: View {
    @Bindable var model: ShareModel

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Add to triage")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { model.cancel() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Add") { Task { await model.send() } }
                            .disabled(!model.canSend)
                    }
                }
        }
        .tint(Theme.accent)
        .task { await model.load() }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading:
            ProgressView()
        case .signedOut:
            message("Sign in to Tallyline first", "Open the Tallyline app and pair this phone, then share again.", symbol: "person.crop.circle.badge.exclamationmark")
        case .nothingToShare:
            message("Nothing to add", "Tallyline can file links and text. Images are not supported yet.", symbol: "doc.questionmark")
        case .finished(let text):
            message(text, "", symbol: "checkmark.circle")
        case .ready, .sending, .failed:
            Form {
                Section {
                    TextField("Title", text: $model.title)
                    TextField("Notes", text: $model.notes, axis: .vertical).lineLimit(3...10)
                }
                Section {
                    if model.teams.isEmpty {
                        LabeledContent("Team", value: "Last used")
                    } else {
                        Picker("Team", selection: $model.teamId) {
                            ForEach(model.teams) { Text($0.name).tag($0.id) }
                        }
                    }
                    LabeledContent("Workspace", value: model.workspaceName)
                }
                if case .failed(let reason) = model.phase {
                    Text(reason).font(.footnote).foregroundStyle(Theme.urgent)
                }
            }
            .disabled(model.phase == .sending)
        }
    }

    private func message(_ title: String, _ detail: String, symbol: String) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: symbol)
        } description: {
            if !detail.isEmpty { Text(detail) }
        }
    }
}
