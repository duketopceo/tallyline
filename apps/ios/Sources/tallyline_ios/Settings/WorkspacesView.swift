#if os(iOS)
import SwiftUI
import TallylineCore
import TallylineDesign

/// Settings > Workspace: switch between the workspaces this phone is paired
/// with. Reached only when the person belongs to more than one.
struct WorkspacesView: View {
    var session: SessionModel
    let credential: DeviceCredential
    @State private var pairing = false
    @State private var switched = 0

    var body: some View {
        Form {
            Section {
                ForEach(session.workspaceChoices) { choice in
                    if choice.isPaired {
                        Button {
                            if session.switchWorkspace(to: choice.slug) { switched += 1 }
                        } label: {
                            row(choice)
                        }
                        .accessibilityAddTraits(choice.isCurrent ? .isSelected : [])
                    } else {
                        row(choice)
                    }
                }
            } footer: {
                Text("Each workspace keeps its own issues and unsent changes on this phone. Unsent changes wait for their own workspace.")
            }
            Section {
                Button("Pair another workspace") { pairing = true }
            } footer: {
                if let error = session.lastError {
                    Text(error).foregroundStyle(Theme.urgent)
                } else {
                    Text("A workspace marked not paired needs a pairing code from Settings > Devices on the web.")
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Workspace")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(isPresented: $pairing) {
            PairView(session: session, serverURL: credential.serverURL)
        }
        .onChange(of: credential.workspaceSlug) { _, _ in pairing = false }
        .onAppear { session.clearError() }
        .sensoryFeedback(.selection, trigger: switched)
    }

    private func row(_ choice: WorkspaceChoice) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(choice.name).foregroundStyle(Theme.ink)
                Text(choice.isPaired ? choice.role.capitalized : "Not paired on this phone")
                    .font(.footnote)
                    .foregroundStyle(Theme.inkMuted)
            }
            Spacer()
            if choice.isCurrent {
                Image(systemName: "checkmark")
                    .foregroundStyle(Theme.accent)
                    .accessibilityHidden(true)
            }
        }
    }
}
#endif
