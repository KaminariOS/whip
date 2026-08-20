import { useEventListener } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useRef } from 'react';
import { AppState, StyleSheet, View } from 'react-native';

import {
  clearRemoteContentProgress,
  loadRemoteContentProgress,
  saveRemoteContentProgress,
  shouldSaveMediaProgress,
  type RemoteContentIdentity,
} from '@/src/services/remoteContentProgress';

interface Props {
  filename: string;
  progressIdentity: RemoteContentIdentity;
  uri: string;
}

export function RemoteVideoPreview({ filename, progressIdentity, uri }: Props) {
  const { fileSize, hostId, modificationDate, remotePath } = progressIdentity;
  const player = useVideoPlayer(uri, videoPlayer => {
    videoPlayer.timeUpdateEventInterval = 5;
  });
  const positionRef = useRef(0);
  const durationRef = useRef(0);
  const identityRef = useRef(progressIdentity);
  identityRef.current = progressIdentity;

  const persist = useCallback(() => {
    const positionSeconds = positionRef.current;
    const durationSeconds = durationRef.current;
    const identity = identityRef.current;
    if (!shouldSaveMediaProgress(positionSeconds, durationSeconds)) {
      clearRemoteContentProgress(identity).catch(() => undefined);
      return;
    }
    saveRemoteContentProgress(identity, {
      kind: 'media',
      positionSeconds,
      durationSeconds,
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    let active = true;
    const effectIdentity = { fileSize, hostId, modificationDate, remotePath };
    positionRef.current = 0;
    durationRef.current = 0;
    loadRemoteContentProgress(effectIdentity).then(progress => {
      if (!active || progress?.kind !== 'media' || progress.positionSeconds <= 0) return;
      positionRef.current = progress.positionSeconds;
      durationRef.current = progress.durationSeconds;
      player.currentTime = progress.positionSeconds;
    });
    return () => {
      active = false;
      const positionSeconds = positionRef.current;
      const durationSeconds = durationRef.current;
      if (shouldSaveMediaProgress(positionSeconds, durationSeconds)) {
        saveRemoteContentProgress(effectIdentity, {
          kind: 'media',
          positionSeconds,
          durationSeconds,
        }).catch(() => undefined);
      } else {
        clearRemoteContentProgress(effectIdentity).catch(() => undefined);
      }
    };
  }, [fileSize, hostId, modificationDate, player, remotePath]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') persist();
    });
    return () => subscription.remove();
  }, [persist]);

  useEventListener(player, 'sourceLoad', ({ duration }) => {
    durationRef.current = duration;
  });
  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    positionRef.current = currentTime;
    durationRef.current = player.duration;
    persist();
  });
  useEventListener(player, 'playingChange', ({ isPlaying }) => {
    if (!isPlaying) persist();
  });
  useEventListener(player, 'playToEnd', () => {
    positionRef.current = 0;
    clearRemoteContentProgress(identityRef.current).catch(() => undefined);
  });

  return (
    <View className="flex-1 bg-terminal-canvas">
      <VideoView
        accessibilityLabel={filename}
        contentFit="contain"
        fullscreenOptions={{ enable: true }}
        nativeControls
        player={player}
        style={styles.video}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  video: {
    flex: 1,
    width: '100%',
  },
});
