const PREVIEW_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "font-src data:",
  "form-action 'none'",
  "frame-src 'self'",
  "img-src data: blob:",
  "media-src data: blob:",
  "object-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline' data:",
].join('; ');

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * Places remote markup inside an inert iframe. The parent policy is inherited
 * by srcdoc documents, while the sandbox and native WebView settings provide
 * separate barriers against scripts, forms, navigation, and network access.
 */
export function buildSandboxedHtmlPreview(content: string, filename: string): string {
  const title = escapeHtmlAttribute(filename);
  const srcdoc = escapeHtmlAttribute(content);

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${PREVIEW_CONTENT_SECURITY_POLICY}">
    <meta name="referrer" content="no-referrer">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      html, body, iframe {
        width: 100%;
        height: 100%;
        margin: 0;
        border: 0;
        background: white;
      }
      body {
        overflow: hidden;
      }
    </style>
  </head>
  <body>
    <iframe title="${title}" sandbox="" referrerpolicy="no-referrer" srcdoc="${srcdoc}"></iframe>
  </body>
</html>`;
}
