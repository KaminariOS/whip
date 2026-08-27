import { View } from 'react-native';

import type { DevicePreferencesController } from '../hooks/useDevicePreferences';
import type { HostManagementController } from '../hooks/useHostManagement';
import type { AppNavigationController } from '../hooks/useAppNavigation';
import type { RemoteFilesController } from '../hooks/useRemoteFilesController';
import type { SessionRuntimeController } from '../hooks/useSessionRuntimeManager';
import type { useApplicationSecurity } from '../hooks/useApplicationSecurity';
import { AppAccessLock } from './AppAccessLock';
import { AppBackground } from './AppBackground';
import { ConnectionScreen } from './ConnectionScreen';
import { DeleteHostConfirmationPopup } from './DeleteHostConfirmationPopup';
import { FullScreenOverlay } from './FullScreenOverlay';
import { GlobalKeychainScreen } from './GlobalKeychainScreen';
import { KnownHostsScreen } from './KnownHostsScreen';
import { LicensesScreen } from './LicensesScreen';
import { NewHostScreen } from './NewHostScreen';
import { PairingSuccessPopup } from './PairingSuccessPopup';
import { PaneDetail } from './PaneDetail';
import { RemoteFileManager } from './RemoteFileManager';
import { TrustHostSheet } from './TrustHostSheet';

interface AppOverlaysProps {
  preferences: DevicePreferencesController;
  hosts: HostManagementController;
  sessions: SessionRuntimeController;
  navigation: AppNavigationController;
  remoteFiles: RemoteFilesController;
  security: ReturnType<typeof useApplicationSecurity>;
}

/** App-wide modal flows. Domain state remains owned by the supplied controllers. */
export function AppOverlays({
  preferences,
  hosts,
  sessions,
  navigation,
  remoteFiles,
  security,
}: AppOverlaysProps) {
  const { appBackgroundImageUri, appBackgroundDimming, biometricForKeys } =
    preferences.value;
  const activeSession = sessions.activeSession;
  const selectedPane =
    navigation.selectedPaneId && activeSession
      ? activeSession.snapshot.panes.find(
          pane => pane.pane_id === navigation.selectedPaneId,
        ) ?? null
      : null;

  return (
    <>
      {hosts.newHostOpen && (
        <View className="absolute inset-0 z-40 bg-background">
          <AppBackground
            uri={appBackgroundImageUri}
            dimming={appBackgroundDimming}
          />
          <NewHostScreen
            onCancel={hosts.closeNewHost}
            onManual={hosts.openManualHost}
            onLoadGlobalKeys={hosts.unlockGlobalKeychain}
            onPaired={hosts.savePairedHost}
          />
        </View>
      )}

      {hosts.editorProfile && (
        <View className="absolute inset-0 z-40 bg-background">
          <AppBackground
            uri={appBackgroundImageUri}
            dimming={appBackgroundDimming}
          />
          <ConnectionScreen
            key={hosts.editorProfile.id}
            initialProfile={hosts.editorProfile}
            hosts={hosts.hosts}
            connecting={sessions.connectingHostIds.has(hosts.editorProfile.id)}
            error={hosts.error}
            onCancel={hosts.closeEditor}
            onSave={hosts.saveHost}
            onConnect={sessions.connect}
            onDelete={
              hosts.hosts.some(host => host.id === hosts.editorProfile?.id)
                ? () => hosts.confirmDelete(hosts.editorProfile!)
                : undefined
            }
            onAuthenticatePrivateKey={
              biometricForKeys ? security.verifyBiometric : undefined
            }
            onLoadGlobalKeys={hosts.unlockGlobalKeychain}
          />
        </View>
      )}

      {hosts.unlockedGlobalKeys !== null && (
        <View className="absolute inset-0 z-50 bg-background">
          <AppBackground
            uri={appBackgroundImageUri}
            dimming={appBackgroundDimming}
          />
          <GlobalKeychainScreen
            initialKeys={hosts.unlockedGlobalKeys}
            onChanged={hosts.updateGlobalKeys}
            onClose={hosts.closeGlobalKeychain}
          />
        </View>
      )}

      {hosts.knownHostsOpen && (
        <FullScreenOverlay>
          <AppBackground
            uri={appBackgroundImageUri}
            dimming={appBackgroundDimming}
          />
          <KnownHostsScreen
            initialHosts={hosts.knownHosts}
            onChanged={hosts.replaceKnownHosts}
            onClose={hosts.closeKnownHosts}
          />
        </FullScreenOverlay>
      )}

      {navigation.licensesOpen && (
        <FullScreenOverlay>
          <AppBackground
            uri={appBackgroundImageUri}
            dimming={appBackgroundDimming}
          />
          <LicensesScreen onClose={navigation.closeLicenses} />
        </FullScreenOverlay>
      )}

      {sessions.activeClient && (
        <PaneDetail
          pane={selectedPane}
          client={sessions.activeClient}
          onClose={() => navigation.selectPane(null)}
          onOpenTerminal={pane => {
            if (activeSession)
              sessions.openPaneTerminal(activeSession.id, pane);
          }}
        />
      )}

      {remoteFiles.request && remoteFiles.client && (
        <RemoteFileManager
          key={remoteFiles.request.id}
          client={remoteFiles.client}
          hostId={remoteFiles.request.hostSessionId}
          initialPath={remoteFiles.request.initialPath}
          initialFilePath={remoteFiles.request.initialFilePath}
          initialLine={remoteFiles.request.initialLine}
          visible
          onPathChange={path =>
            remoteFiles.rememberPath(remoteFiles.request!.id, path)
          }
          onClose={() => remoteFiles.close(remoteFiles.request?.id)}
        />
      )}

      <TrustHostSheet
        challenge={hosts.unknownHostChallenge}
        onCancel={() => hosts.resolveUnknownHost(false)}
        onTrust={() => hosts.resolveUnknownHost(true)}
      />
      <DeleteHostConfirmationPopup
        busy={hosts.deleteHostBusy}
        host={hosts.deleteHostTarget}
        onCancel={hosts.cancelDelete}
        onDelete={() => {
          hosts.deleteConfirmed().catch(() => undefined);
        }}
      />
      <PairingSuccessPopup
        result={hosts.pairingSuccess}
        onClose={hosts.closePairingSuccess}
      />
      <AppAccessLock
        authenticating={security.authenticating}
        visible={security.locked}
        onRetry={() => {
          security.authenticateLockedApp().catch(() => undefined);
        }}
      />
    </>
  );
}
