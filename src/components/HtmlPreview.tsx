import { StyleSheet } from 'react-native';
import WebView from 'react-native-webview';

interface Props {
  filename: string;
  revision: number;
  uri: string;
}

export function HtmlPreview({ filename, revision, uri }: Props) {
  const previewUrl = `${uri}${uri.includes('?') ? '&' : '?'}__whip_preview=${revision}`;
  return (
    <WebView
      accessibilityLabel={`Preview ${filename}`}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      cacheEnabled={false}
      domStorageEnabled
      javaScriptCanOpenWindowsAutomatically={false}
      javaScriptEnabled
      mediaPlaybackRequiresUserAction
      nestedScrollEnabled
      originWhitelist={['http://*', 'https://*']}
      setSupportMultipleWindows={false}
      source={{ uri: previewUrl }}
      style={styles.preview}
      thirdPartyCookiesEnabled={false}
    />
  );
}

const styles = StyleSheet.create({
  preview: {
    backgroundColor: '#ffffff',
    flex: 1,
  },
});
