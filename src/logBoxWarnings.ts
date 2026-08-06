import { LogBox } from 'react-native';

// NativeWind 4's CSS interop registers both safe-area implementations and
// touches React Native's deprecated export even though Whip uses
// react-native-safe-area-context. Keep every other development warning visible.
if (__DEV__) {
  LogBox.ignoreLogs([
    "SafeAreaView has been deprecated and will be removed in a future release. Please use 'react-native-safe-area-context' instead.",
  ]);
}
