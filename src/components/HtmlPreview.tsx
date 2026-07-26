import { StyleSheet } from 'react-native';
import WebView from 'react-native-webview/lib/WebView.android';

import { buildSandboxedHtmlPreview } from '@/src/lib/htmlPreview';

interface Props {
  content: string;
  filename: string;
}

export function HtmlPreview({ content, filename }: Props) {
  return (
    <WebView
      accessibilityLabel={`Preview ${filename}`}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      cacheEnabled={false}
      domStorageEnabled={false}
      javaScriptCanOpenWindowsAutomatically={false}
      javaScriptEnabled={false}
      mediaPlaybackRequiresUserAction
      nestedScrollEnabled
      originWhitelist={[]}
      setSupportMultipleWindows={false}
      source={{ html: buildSandboxedHtmlPreview(content, filename) }}
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
