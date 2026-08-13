export type AppLogLevel = 'debug' | 'info' | 'log' | 'warn' | 'error';

export interface AppLogEntry {
  id: number;
  timestamp: string;
  level: AppLogLevel;
  message: string;
}

const MAX_LOG_ENTRIES = 500;
const MAX_LOG_CHARACTERS = 200_000;
const MAX_ENTRY_CHARACTERS = 8_000;
const listeners = new Set<() => void>();
const entries: AppLogEntry[] = [];
let snapshot: readonly AppLogEntry[] = [];
let entryCharacters = 0;
let nextId = 1;
let installed = false;

const consoleMethods: readonly AppLogLevel[] = [
  'debug',
  'info',
  'log',
  'warn',
  'error',
];

export function installAppLogCapture(): void {
  if (installed) return;
  installed = true;

  for (const level of consoleMethods) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try {
        appendAppLog(level, args);
      } finally {
        original(...args);
      }
    };
  }

  appendAppLog('info', ['App log capture started.']);
}

export function getAppLogEntries(): readonly AppLogEntry[] {
  return snapshot;
}

export function formatAppLogs(
  logEntries: readonly AppLogEntry[] = snapshot,
): string {
  return logEntries
    .map(
      entry =>
        `${entry.timestamp} ${entry.level.toUpperCase().padEnd(5)} ${
          entry.message
        }`,
    )
    .join('\n');
}

export function subscribeToAppLogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function appendAppLog(level: AppLogLevel, args: readonly unknown[]): void {
  const message = args
    .map(formatLogArgument)
    .join(' ')
    .slice(0, MAX_ENTRY_CHARACTERS);
  const entry: AppLogEntry = {
    id: nextId,
    timestamp: new Date().toISOString(),
    level,
    message,
  };
  nextId += 1;
  entries.push(entry);
  entryCharacters += message.length;

  while (
    entries.length > MAX_LOG_ENTRIES ||
    entryCharacters > MAX_LOG_CHARACTERS
  ) {
    const removed = entries.shift();
    if (!removed) break;
    entryCharacters -= removed.message.length;
  }

  snapshot = entries.slice();
  for (const listener of listeners) listener();
}

function formatLogArgument(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error)
    return value.stack || `${value.name}: ${value.message}`;
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function')
    return `[Function ${value.name || 'anonymous'}]`;
  if (value === undefined) return 'undefined';

  try {
    const seen = new WeakSet<object>();
    return (
      JSON.stringify(value, (_key, nestedValue: unknown) => {
        if (typeof nestedValue === 'bigint')
          return `${nestedValue.toString()}n`;
        if (nestedValue && typeof nestedValue === 'object') {
          if (seen.has(nestedValue)) return '[Circular]';
          seen.add(nestedValue);
        }
        return nestedValue;
      }) ?? String(value)
    );
  } catch {
    return String(value);
  }
}
