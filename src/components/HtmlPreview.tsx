import { StyleSheet } from 'react-native';
import WebView from 'react-native-webview';

interface Props {
  filename: string;
  revision: number;
  uri: string;
}

/**
 * Loads the live preview served through the SSH tunnel. JavaScript and DOM
 * storage are intentional here so multi-file web apps behave as they do in a
 * browser; this is not the former inert, inline-document preview.
 */
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
