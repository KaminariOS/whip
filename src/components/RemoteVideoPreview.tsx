import { useVideoPlayer, VideoView } from 'expo-video';
import { StyleSheet, View } from 'react-native';

interface Props {
  filename: string;
  uri: string;
}

export function RemoteVideoPreview({ filename, uri }: Props) {
  const player = useVideoPlayer(uri);

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
