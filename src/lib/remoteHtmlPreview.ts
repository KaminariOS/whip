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

const NODE_HTTP_SERVER = `
const fs = require("fs")
const http = require("http")
const path = require("path")

const root = path.resolve(process.argv[1])
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
}

const respond = (response, status, body) => {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" })
  response.end(body)
}
const server = http.createServer((request, response) => {
  let pathname
  try {
    pathname = decodeURIComponent(new URL(request.url || "/", "http://127.0.0.1").pathname)
  } catch {
    respond(response, 400, "Bad request")
    return
  }
  let filename = path.resolve(root, "." + pathname)
  if (filename !== root && !filename.startsWith(root + path.sep)) {
    respond(response, 403, "Forbidden")
    return
  }
  const sendFile = candidate => {
    fs.readFile(candidate, (error, data) => {
      if (error) {
        respond(response, error.code === "ENOENT" ? 404 : 500, error.code === "ENOENT" ? "Not found" : "Preview error")
        return
      }
      response.writeHead(200, { "Content-Type": contentTypes[path.extname(candidate).toLowerCase()] || "application/octet-stream" })
      response.end(data)
    })
  }
  fs.stat(filename, (error, stats) => {
    if (error) {
      respond(response, error.code === "ENOENT" ? 404 : 500, error.code === "ENOENT" ? "Not found" : "Preview error")
      return
    }
    if (stats.isDirectory()) filename = path.join(filename, "index.html")
    sendFile(filename)
  })
})
server.listen(0, "127.0.0.1", () => console.log(server.address().port))
const timer = setTimeout(() => server.close(), ${MAX_PREVIEW_SECONDS * 1000})
timer.unref()
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
  const script = [
    `rm -f ${shellQuote(portFile)} ${shellQuote(logFile)}`,
    'if command -v python3 >/dev/null 2>&1; then',
    `  nohup python3 -c ${shellQuote(PYTHON_HTTP_SERVER)} ${shellQuote(directory)} >${shellQuote(portFile)} 2>${shellQuote(logFile)} </dev/null &`,
    'elif command -v node >/dev/null 2>&1; then',
    `  nohup node -e ${shellQuote(NODE_HTTP_SERVER)} ${shellQuote(directory)} >${shellQuote(portFile)} 2>${shellQuote(logFile)} </dev/null &`,
    'else',
    `  printf '${START_ERROR_PREFIX}%s\\n' 'Neither python3 nor node is installed on the remote host'`,
    '  exit 0',
    'fi',
    'preview_pid=$!',
    'preview_attempt=0',
    'while [ "$preview_attempt" -lt 50 ]; do',
    `  if [ -s ${shellQuote(portFile)} ]; then IFS= read -r preview_port < ${shellQuote(portFile)}; printf '%s:%s\\n' "$preview_pid" "$preview_port"; exit 0; fi`,
    `  if ! kill -0 "$preview_pid" 2>/dev/null; then printf '${START_ERROR_PREFIX}%s\\n' 'The preview server process failed to start'; sed -n '1,3p' ${shellQuote(logFile)}; exit 0; fi`,
    '  preview_attempt=$((preview_attempt + 1))',
    '  sleep 0.1',
    'done',
    'kill "$preview_pid" 2>/dev/null || true',
    `printf '${START_ERROR_PREFIX}%s\\n' 'Timed out starting the remote preview server'`,
  ].join('\n');
  return `sh -c ${shellQuote(script)}`;
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
  const script = [
    `kill ${process.pid} 2>/dev/null || true`,
    `rm -f ${shellQuote(process.portFile)} ${shellQuote(process.logFile)}`,
  ].join('\n');
  return `sh -c ${shellQuote(script)}`;
}

export function remoteHtmlPreviewPageUrl(remotePort: number, filename: string): string {
  return `http://127.0.0.1:${remotePort}/${encodeURIComponent(filename)}`;
}

function remoteHtmlPreviewTemporaryFile(token: string, extension: 'port' | 'log'): string {
  if (!/^[a-z0-9-]+$/i.test(token)) throw new Error('Invalid remote HTML preview token');
  return `/tmp/whip-html-preview-${token}.${extension}`;
}
