import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import androidImeBridge from './android-ime-bridge.cjs';

const { installAndroidImeBridge, terminalInputDelta } = androidImeBridge;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = resolve(root, 'android/app/src/main/assets');
const terminalFonts = resolve(root, 'assets/terminal-fonts');
const fontManifest = JSON.parse(
  await readFile(resolve(terminalFonts, 'manifest.json'), 'utf8'),
);
const jetBrainsMonoRegular = resolve(
  terminalFonts,
  fontManifest.text.regularFile,
);
const jetBrainsMonoBold = resolve(terminalFonts, fontManifest.text.boldFile);
const jetBrainsMonoLicense = resolve(
  terminalFonts,
  fontManifest.text.licenseFile,
);
const cjkRegular = resolve(terminalFonts, fontManifest.cjk.regularFile);
const cjkLicense = resolve(terminalFonts, fontManifest.cjk.licenseFile);
const nerdSymbolsRegular = resolve(
  terminalFonts,
  fontManifest.symbols.regularFile,
);
const nerdSymbolsLicense = resolve(
  terminalFonts,
  fontManifest.symbols.licenseFile,
);
const terminalFontFamily = [
  fontManifest.text.cssFamily,
  fontManifest.emoji.cssFamily,
  fontManifest.symbols.cssFamily,
  fontManifest.cjk.cssFamily,
  fontManifest.fallback.cssFamily,
].map(family => family === 'monospace' ? family : `"${family}"`).join(', ');
const [
  jetBrainsMonoRegularData,
  jetBrainsMonoBoldData,
  nerdSymbolsRegularData,
] = await Promise.all([
  readFile(jetBrainsMonoRegular).then(font => font.toString('base64')),
  readFile(jetBrainsMonoBold).then(font => font.toString('base64')),
  readFile(nerdSymbolsRegular).then(font => font.toString('base64')),
]);

await mkdir(assets, { recursive: true });
await Promise.all([
  copyFile(
    resolve(root, 'node_modules/@xterm/xterm/lib/xterm.js'),
    resolve(assets, 'xterm.js'),
  ),
  copyFile(
    resolve(root, 'node_modules/@xterm/xterm/css/xterm.css'),
    resolve(assets, 'xterm.css'),
  ),
  copyFile(
    resolve(root, 'node_modules/@xterm/addon-fit/lib/addon-fit.js'),
    resolve(assets, 'addon-fit.js'),
  ),
  copyFile(
    jetBrainsMonoRegular,
    resolve(assets, fontManifest.text.bundledRegularFile),
  ),
  copyFile(
    jetBrainsMonoBold,
    resolve(assets, fontManifest.text.bundledBoldFile),
  ),
  copyFile(
    jetBrainsMonoLicense,
    resolve(assets, fontManifest.text.bundledLicenseFile),
  ),
  copyFile(cjkRegular, resolve(assets, fontManifest.cjk.bundledRegularFile)),
  copyFile(cjkLicense, resolve(assets, fontManifest.cjk.bundledLicenseFile)),
  copyFile(
    nerdSymbolsRegular,
    resolve(assets, fontManifest.symbols.bundledRegularFile),
  ),
  copyFile(
    nerdSymbolsLicense,
    resolve(assets, fontManifest.symbols.bundledLicenseFile),
  ),
]);

const terminalHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <link rel="stylesheet" href="xterm.css">
  <style>
    @font-face {
      font-family: '${fontManifest.text.cssFamily}';
      src: url('data:font/ttf;base64,${jetBrainsMonoRegularData}') format('truetype');
      font-style: normal;
      font-weight: 400;
      font-display: block;
    }
    @font-face {
      font-family: '${fontManifest.text.cssFamily}';
      src: url('data:font/ttf;base64,${jetBrainsMonoBoldData}') format('truetype');
      font-style: normal;
      font-weight: 700;
      font-display: block;
    }
    @font-face {
      font-family: '${fontManifest.symbols.cssFamily}';
      src: url('data:font/ttf;base64,${nerdSymbolsRegularData}') format('truetype');
      font-style: normal;
      font-weight: 400;
      font-display: block;
    }
    @font-face {
      font-family: '${fontManifest.cjk.cssFamily}';
      src: url('${fontManifest.cjk.bundledRegularFile}') format('truetype');
      font-style: normal;
      font-weight: 400;
      font-display: block;
    }
    html, body, #terminal { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
    html { -webkit-text-size-adjust: none; text-size-adjust: none; }
    #terminal-background-layer { position: fixed; inset: 0; z-index: 2; display: none; mix-blend-mode: screen; pointer-events: none; }
    #terminal-background-image { width: 100%; height: 100%; object-fit: cover; }
    #terminal-background-glass { position: absolute; inset: 0; }
    #terminal { position: relative; z-index: 1; box-sizing: border-box; }
    .xterm { height: 100%; }
    .xterm-viewport { overflow-y: hidden !important; scrollbar-width: none !important; background-color: transparent !important; }
    .xterm-viewport::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
    .xterm .scrollbar { display: none !important; }
    #selection-toolbar { position: fixed; z-index: 20; display: none; gap: 1px; padding: 3px; background: #24283b; border: 1px solid #414868; border-radius: 10px; box-shadow: 0 4px 16px #0008; }
    #selection-toolbar button { appearance: none; border: 0; border-radius: 7px; background: transparent; color: #c0caf5; padding: 8px 10px; font: 700 10px '${fontManifest.text.cssFamily}', monospace; }
    #selection-toolbar button:active { background: #7aa2f7; color: #16161e; }
  </style>
</head>
<body>
  <div id="terminal-background-layer">
    <img id="terminal-background-image" alt="" />
    <div id="terminal-background-glass"></div>
  </div>
  <div id="terminal"></div>
  <div id="selection-toolbar"><button id="copy-selection">COPY</button><button id="paste-selection">PASTE</button></div>
  <script src="xterm.js"></script>
  <script src="addon-fit.js"></script>
  <script>
    ${terminalInputDelta.toString()}
    ${installAndroidImeBridge.toString()}
    const terminalFontFamily = '${terminalFontFamily}';
    const fontReady = document.fonts?.load
      ? Promise.all([
          document.fonts.load('400 8px "${fontManifest.text.cssFamily}"'),
          document.fonts.load('700 8px "${fontManifest.text.cssFamily}"'),
          document.fonts.load('400 8px "${fontManifest.symbols.cssFamily}"', '\\uf120'),
          document.fonts.load('400 8px "${fontManifest.cjk.cssFamily}"', '\\u4e2d'),
        ]).then(() => document.fonts.ready)
      : Promise.resolve();
    const initializeTerminal = () => {
      const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      allowTransparency: true,
      fontFamily: terminalFontFamily,
      fontSize: 8,
      fontWeight: '400',
      fontWeightBold: '700',
      lineHeight: 1.12,
      letterSpacing: 0,
      scrollback: 5000,
      overviewRuler: { width: 1 },
      theme: {
        background: 'rgba(0,0,0,0)', foreground: '#c0caf5', cursor: '#c0caf5', selectionBackground: '#283457',
        black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
        blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
        brightBlack: '#414868', brightRed: '#ff899d', brightGreen: '#9fe044',
        brightYellow: '#faba4a', brightBlue: '#8db0ff', brightMagenta: '#c7a9ff',
        brightCyan: '#a4daff', brightWhite: '#c0caf5'
      }
    });
    const fit = new FitAddon.FitAddon();
    terminal.loadAddon(fit);
    terminal.open(document.getElementById('terminal'));
    const send = value => window.ReactNativeWebView.postMessage(JSON.stringify(value));
    let lastTap = null;
    let doubleTapTabEnabled = true;
    installAndroidImeBridge(terminal, send, navigator.userAgent);
    const controlSequenceForKey = key => {
      const upper = key.length === 1 ? key.toUpperCase() : '';
      return upper >= 'A' && upper <= 'Z' ? String.fromCharCode(upper.charCodeAt(0) - 64) : null;
    };
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) return true;
      const sequence = controlSequenceForKey(event.key);
      if (sequence === null) return true;
      event.preventDefault();
      event.stopPropagation();
      send({ type: 'input', data: sequence });
      return false;
    });
    let bufferedInput = null;
    terminal.onData(data => {
      if (bufferedInput !== null) bufferedInput += data;
      else send({ type: 'input', data });
    });
    terminal.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));
    terminal.parser.registerOscHandler(52, data => {
      const separator = data.indexOf(';');
      const payload = separator >= 0 ? data.slice(separator + 1) : '';
      if (!payload || payload === '?') return true;
      try { send({ type: 'clipboard-write', text: decodeURIComponent(escape(atob(payload))) }); } catch {}
      return true;
    });
    window.herdrWrite = data => terminal.write(data);
    window.herdrWriteBase64 = data => {
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      terminal.write(bytes);
    };
    const pendingFrames = new Map();
    window.herdrWriteBase64Chunk = (sequence, data, final) => {
      const encoded = (pendingFrames.get(sequence) || '') + data;
      if (!final) {
        pendingFrames.set(sequence, encoded);
        return;
      }
      pendingFrames.delete(sequence);
      window.herdrWriteBase64(encoded);
    };
    window.herdrReset = () => {
      pendingFrames.clear();
      terminal.reset();
    };
    window.herdrConfigure = options => {
      terminal.options.fontSize = Math.max(8, Math.min(24, Number(options.fontSize) || 8));
      terminal.options.scrollback = Math.max(1000, Math.min(20000, Number(options.scrollback) || 5000));
      terminal.options.cursorBlink = options.cursorBlink !== false;
      doubleTapTabEnabled = options.doubleTapTab !== false;
      if (!doubleTapTabEnabled) lastTap = null;
      const backgroundUri = options.backgroundImageUri || '';
      const dimming = Math.max(0, Math.min(100, Number(options.backgroundDimming) || 0)) / 100;
      const backgroundLayer = document.getElementById('terminal-background-layer');
      const backgroundImage = document.getElementById('terminal-background-image');
      const backgroundGlass = document.getElementById('terminal-background-glass');
      backgroundLayer.style.display = backgroundUri ? 'block' : 'none';
      backgroundImage.src = backgroundUri;
      backgroundGlass.style.backgroundColor = 'rgba(0,0,0,' + dimming + ')';
      setTimeout(resize, 0);
    };
    window.herdrPaste = data => { terminal.paste(data); hideToolbar(); };
    window.herdrSubmit = data => {
      bufferedInput = '';
      terminal.paste(data);
      const value = bufferedInput;
      bufferedInput = null;
      send({ type: 'buffered-submit', data: value });
      hideToolbar();
    };
    let searchState = { query: '', caseSensitive: false, regex: false, matches: [], index: -1 };
    window.herdrClearSearch = () => { terminal.clearSelection(); searchState = { query: '', caseSensitive: false, regex: false, matches: [], index: -1 }; };
    window.herdrSearch = (query, caseSensitive, regex, direction) => {
      const changed = query !== searchState.query || caseSensitive !== searchState.caseSensitive || regex !== searchState.regex;
      if (changed) {
        const matches = [];
        let invalid = false;
        let expression = null;
        if (query && regex) {
          try { expression = new RegExp(query, caseSensitive ? 'g' : 'gi'); } catch { invalid = true; }
        }
        if (query && !invalid) {
          for (let row = 0; row < terminal.buffer.active.length; row += 1) {
            const line = terminal.buffer.active.getLine(row)?.translateToString(true) || '';
            if (expression) {
              expression.lastIndex = 0;
              let match;
              while ((match = expression.exec(line))) {
                matches.push({ row, col: match.index, length: Math.max(1, match[0].length) });
                if (match[0].length === 0) expression.lastIndex += 1;
              }
            } else {
              const source = caseSensitive ? line : line.toLowerCase();
              const needle = caseSensitive ? query : query.toLowerCase();
              let col = source.indexOf(needle);
              while (col >= 0) {
                matches.push({ row, col, length: query.length });
                col = source.indexOf(needle, col + Math.max(1, query.length));
              }
            }
          }
        }
        searchState = { query, caseSensitive, regex, matches, index: matches.length ? (direction < 0 ? matches.length - 1 : 0) : -1 };
        if (invalid) { send({ type: 'search-result', count: 0, index: -1, invalid: true }); return; }
      } else if (searchState.matches.length) {
        searchState.index = (searchState.index + direction + searchState.matches.length) % searchState.matches.length;
      }
      const match = searchState.matches[searchState.index];
      if (match) {
        terminal.select(match.col, match.row, match.length);
        terminal.scrollToLine(match.row);
      } else {
        terminal.clearSelection();
      }
      send({ type: 'search-result', count: searchState.matches.length, index: searchState.index, invalid: false });
    };
    const resize = () => {
      fit.fit();
      const screen = terminal.element?.querySelector('.xterm-screen');
      const rect = screen?.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      send({
        type: 'resize',
        cols: terminal.cols,
        rows: terminal.rows,
        cellWidthPx: rect ? Math.round((rect.width / terminal.cols) * scale) : 0,
        cellHeightPx: rect ? Math.round((rect.height / terminal.rows) * scale) : 0
      });
    };
    window.herdrFocus = () => terminal.focus();
    window.herdrBlur = () => terminal.blur();
    window.herdrFit = resize;
    const toolbar = document.getElementById('selection-toolbar');
    const hideToolbar = () => { toolbar.style.display = 'none'; };
    const showToolbar = (x, y) => {
      toolbar.style.display = 'flex';
      toolbar.style.left = Math.max(6, Math.min(window.innerWidth - 128, x - 48)) + 'px';
      toolbar.style.top = Math.max(6, Math.min(window.innerHeight - 52, y - 48)) + 'px';
    };
    document.getElementById('copy-selection').addEventListener('click', event => {
      event.stopPropagation();
      const text = terminal.getSelection();
      if (text) send({ type: 'clipboard-write', text });
      hideToolbar();
    });
    document.getElementById('paste-selection').addEventListener('click', event => {
      event.stopPropagation();
      send({ type: 'clipboard-read' });
      hideToolbar();
    });
    const selectWordAt = (x, y) => {
      const screen = terminal.element?.querySelector('.xterm-screen');
      const rect = screen?.getBoundingClientRect();
      if (!rect) return false;
      const col = Math.max(0, Math.min(terminal.cols - 1, Math.floor((x - rect.left) / (rect.width / terminal.cols))));
      const viewportRow = Math.max(0, Math.min(terminal.rows - 1, Math.floor((y - rect.top) / (rect.height / terminal.rows))));
      const row = terminal.buffer.active.viewportY + viewportRow;
      const line = terminal.buffer.active.getLine(row)?.translateToString(true) || '';
      if (!line[col] || /\\s/.test(line[col])) return false;
      const wordChar = character => character && /[A-Za-z0-9_./:@~+-]/.test(character);
      let start = col;
      let end = col + 1;
      while (start > 0 && wordChar(line[start - 1])) start -= 1;
      while (end < line.length && wordChar(line[end])) end += 1;
      terminal.select(start, row, Math.max(1, end - start));
      return true;
    };
    let touch = null;
    let pinch = null;
    let longPressTimer = null;
    const doubleTapTimeoutMs = 300;
    const doubleTapDistancePx = 24;
    const touchDistance = touches => Math.hypot(
      touches[1].clientX - touches[0].clientX,
      touches[1].clientY - touches[0].clientY,
    );
    document.getElementById('terminal').addEventListener('touchstart', event => {
      if (event.target.closest?.('#selection-toolbar')) return;
      if (event.touches.length === 2) {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        event.preventDefault();
        event.stopPropagation();
        hideToolbar();
        touch = null;
        lastTap = null;
        pinch = {
          distance: Math.max(1, touchDistance(event.touches)),
          initialFontSize: terminal.options.fontSize,
          fontSize: terminal.options.fontSize,
        };
        return;
      }
      if (event.touches.length !== 1) { touch = null; pinch = null; lastTap = null; return; }
      const point = event.touches[0];
      hideToolbar();
      touch = { x: point.clientX, y: point.clientY, lastY: point.clientY, carry: 0, moved: false, longPressed: false };
      longPressTimer = setTimeout(() => {
        if (!touch || touch.moved) return;
        touch.longPressed = true;
        lastTap = null;
        event.preventDefault();
        event.stopPropagation();
        if (selectWordAt(touch.x, touch.y)) showToolbar(touch.x, touch.y);
        else send({ type: 'clipboard-read' });
      }, 420);
    }, { capture: true, passive: false });
    document.getElementById('terminal').addEventListener('touchmove', event => {
      if (pinch && event.touches.length === 2) {
        event.preventDefault();
        event.stopPropagation();
        const ratio = touchDistance(event.touches) / pinch.distance;
        const fontSize = Math.max(8, Math.min(24, Math.round(pinch.initialFontSize * ratio)));
        if (fontSize !== pinch.fontSize) {
          pinch.fontSize = fontSize;
          terminal.options.fontSize = fontSize;
          resize();
        }
        return;
      }
      if (pinch) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!touch || event.touches.length !== 1) return;
      const point = event.touches[0];
      if (!touch.moved && Math.hypot(point.clientX - touch.x, point.clientY - touch.y) < 10) return;
      touch.moved = true;
      lastTap = null;
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      event.preventDefault();
      event.stopPropagation();
      const screen = terminal.element?.querySelector('.xterm-screen');
      const cellHeight = screen ? screen.getBoundingClientRect().height / terminal.rows : 16;
      const total = touch.carry + (point.clientY - touch.lastY) / cellHeight;
      const lines = Math.trunc(total);
      touch.carry = total - lines;
      touch.lastY = point.clientY;
      if (lines !== 0) send({ type: 'scroll', direction: lines > 0 ? 'up' : 'down', lines: Math.abs(lines) });
    }, { capture: true, passive: false });
    document.getElementById('terminal').addEventListener('touchend', event => {
      if (pinch) {
        event.preventDefault();
        event.stopPropagation();
        if (event.touches.length < 2) {
          const fontSize = pinch.fontSize;
          pinch = null;
          terminal.options.fontSize = fontSize;
          resize();
          send({ type: 'font-size-change', fontSize });
        }
        return;
      }
      if (!touch) return;
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      const point = event.changedTouches[0];
      if (touch.longPressed) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (!touch.moved && !touch.longPressed && point) {
        const now = { time: Date.now(), x: point.clientX, y: point.clientY };
        if (doubleTapTabEnabled && lastTap && now.time - lastTap.time <= doubleTapTimeoutMs && Math.hypot(now.x - lastTap.x, now.y - lastTap.y) <= doubleTapDistancePx) {
          event.preventDefault();
          event.stopImmediatePropagation();
          send({ type: 'input', data: '\\t' });
          lastTap = null;
        } else {
          lastTap = now;
        }
      }
      touch = null;
    }, { capture: true, passive: false });
    document.getElementById('terminal').addEventListener('touchcancel', () => {
      if (longPressTimer) clearTimeout(longPressTimer);
      longPressTimer = null;
      touch = null;
      pinch = null;
      lastTap = null;
    }, { capture: true });
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('scroll', resize);
    let readySent = false;
    const announceReady = () => {
      resize();
      if (!readySent) {
        readySent = true;
        send({ type: 'ready' });
      }
    };
      announceReady();
    };
    Promise.race([
      fontReady.catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 1500)),
    ]).then(initializeTerminal);
  </script>
</body>
</html>`;

const generated = resolve(root, 'src/generated');
await mkdir(generated, { recursive: true });
await Promise.all([
  writeFile(resolve(assets, 'herdr-terminal.html'), terminalHtml, 'utf8'),
  writeFile(
    resolve(generated, 'terminalHtml.ts'),
    `// Generated by scripts/sync-terminal-assets.mjs. Do not edit directly.\nexport const terminalHtml = ${JSON.stringify(
      terminalHtml,
    )};\n`,
    'utf8',
  ),
]);
