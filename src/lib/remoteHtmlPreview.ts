import { shellQuote } from './shell';

const START_ERROR_PREFIX = '__WHIP_HTML_PREVIEW_ERROR__:';
const MAX_PREVIEW_SECONDS = 60 * 60;

const PYTHON_HTTP_SERVER = `
import http.server
import os
import sys
import threading

os.chdir(sys.argv[1])
server_class = getattr(http.server, "ThreadingHTTPServer", http.server.HTTPServer)
server = server_class(("127.0.0.1", 0), http.server.SimpleHTTPRequestHandler)
timer = threading.Timer(${MAX_PREVIEW_SECONDS}, server.shutdown)
timer.daemon = True
timer.start()
print(server.server_port, flush=True)
try:
    server.serve_forever()
finally:
    server.server_close()
`.trim();

export interface RemoteHtmlServerProcess {
  pid: number;
  port: number;
  portFile: string;
  logFile: string;
}

export function remoteHtmlPreviewStartCommand(directory: string, token: string): string {
  const portFile = remoteHtmlPreviewTemporaryFile(token, 'port');
  const logFile = remoteHtmlPreviewTemporaryFile(token, 'log');
  return [
    `if ! command -v python3 >/dev/null 2>&1; then printf '${START_ERROR_PREFIX}%s\\n' 'python3 is not installed on the remote host'; exit 0; fi`,
    `rm -f ${shellQuote(portFile)} ${shellQuote(logFile)}`,
    `nohup python3 -c ${shellQuote(PYTHON_HTTP_SERVER)} ${shellQuote(directory)} ${shellQuote(token)} >${shellQuote(portFile)} 2>${shellQuote(logFile)} </dev/null &`,
    'preview_pid=$!',
    'preview_attempt=0',
    'while [ "$preview_attempt" -lt 50 ]; do',
    `  if [ -s ${shellQuote(portFile)} ]; then IFS= read -r preview_port < ${shellQuote(portFile)}; printf '%s:%s\\n' "$preview_pid" "$preview_port"; exit 0; fi`,
    `  if ! kill -0 "$preview_pid" 2>/dev/null; then printf '${START_ERROR_PREFIX}%s\\n' 'python3 failed to start the preview server'; sed -n '1,3p' ${shellQuote(logFile)}; exit 0; fi`,
    '  preview_attempt=$((preview_attempt + 1))',
    '  sleep 0.1',
    'done',
    'kill "$preview_pid" 2>/dev/null || true',
    `printf '${START_ERROR_PREFIX}%s\\n' 'Timed out starting the remote preview server'`,
  ].join('\n');
}

export function parseRemoteHtmlPreviewStart(
  output: string,
  token: string,
): RemoteHtmlServerProcess {
  const lines = output.split(/\r?\n/);
  const errorIndex = lines.findIndex(line => line.startsWith(START_ERROR_PREFIX));
  if (errorIndex >= 0) {
    const detail = lines
      .slice(errorIndex + 1)
      .map(line => line.trim())
      .filter(Boolean)
      .join('\n');
    const message = lines[errorIndex].slice(START_ERROR_PREFIX.length);
    throw new Error(`${message}${detail ? `\n${detail}` : ''}`);
  }

  const match = output.match(/(?:^|\r?\n)(\d+):(\d+)(?:\r?\n|$)/);
  const pid = Number(match?.[1]);
  const port = Number(match?.[2]);
  if (!Number.isInteger(pid) || pid < 1 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(output.trim() || 'The remote preview server returned no address');
  }
  return {
    pid,
    port,
    portFile: remoteHtmlPreviewTemporaryFile(token, 'port'),
    logFile: remoteHtmlPreviewTemporaryFile(token, 'log'),
  };
}

export function remoteHtmlPreviewStopCommand(process: RemoteHtmlServerProcess): string {
  return [
    `kill ${process.pid} 2>/dev/null || true`,
    `rm -f ${shellQuote(process.portFile)} ${shellQuote(process.logFile)}`,
  ].join('\n');
}

export function remoteHtmlPreviewPageUrl(remotePort: number, filename: string): string {
  return `http://127.0.0.1:${remotePort}/${encodeURIComponent(filename)}`;
}

function remoteHtmlPreviewTemporaryFile(token: string, extension: 'port' | 'log'): string {
  if (!/^[a-z0-9-]+$/i.test(token)) throw new Error('Invalid remote HTML preview token');
  return `/tmp/whip-html-preview-${token}.${extension}`;
}
