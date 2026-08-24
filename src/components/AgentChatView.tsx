import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  ExternalLink,
  File,
  Minimize2,
  Paperclip,
  Send,
  X,
} from 'lucide-react-native';
import {
  ActivityIndicator,
  Clipboard,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type TextInput as TextInputHandle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type {
  AgentChatState,
  JsonObject,
  TranscriptFilePart,
  TranscriptMessage,
  TranscriptPart,
  TranscriptToolPart,
  TranscriptTurn,
} from '../agentChat';
import { useKeyboardInset } from '../hooks/useKeyboardInset';
import type { ChatAgent } from '../lib/agentChatSession';
import { transcriptFileLinkTarget, type TranscriptFileLinkTarget } from '../lib/transcriptLinks';
import { cn } from '../lib/utils';
import { useTheme } from '../theme';
import { MarkdownText } from './MarkdownText';
import { ComposerInput, MessageComposer } from './MessageComposer';
import type { TerminalComposerQueueItem } from './TerminalScreen';
import { Button } from './ui/button';
import { Text } from './ui/text';

interface Props {
  state: AgentChatState;
  agent: ChatAgent;
  attachments: readonly string[];
  draft: string;
  queue: readonly TerminalComposerQueueItem[];
  sending: boolean;
  onOpenTerminal: () => void;
  onAttach: () => void;
  onDraftChange: (value: string) => void;
  onOpenFile: (target: TranscriptFileLinkTarget) => void;
  onRemoveAttachment: (path: string) => void;
  onSubmit: (text: string) => Promise<boolean>;
}

const TOOL_OUTPUT_SCROLL_STYLE = { maxHeight: 240 } as const;
const TOOL_DIFF_SCROLL_STYLE = { maxHeight: 280 } as const;

type ToolKind = 'command' | 'file' | 'mcp' | 'web' | 'other';

interface ToolPresentation {
  title: string;
  subtitle?: string;
  args: string[];
  command?: string;
  href?: string;
  kind: ToolKind;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const joined = value.filter(part => typeof part === 'string').join(' ');
    return joined || undefined;
  }
  return undefined;
}

function inputValue(input: JsonObject | undefined, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = stringValue(input?.[key]);
    if (value) return value;
  }
  return undefined;
}

function filename(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path.replace(/\/+$/, '').split('/').pop() || path;
}

function primitiveArgs(input: JsonObject | undefined, omitted: readonly string[]): string[] {
  if (!input) return [];
  const skip = new Set(omitted);
  return Object.entries(input).flatMap(([key, value]) => {
    if (skip.has(key)) return [];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const text = String(value).trim();
      return text ? [`${key}=${text}`] : [];
    }
    return [];
  }).slice(0, 2);
}

function toolKind(name: string): ToolKind {
  if (/apply[_-]?patch|patch|edit|write|file|read/i.test(name)) return 'file';
  if (/exec|bash|shell|command|terminal/i.test(name)) return 'command';
  if (/web|search|fetch|open_page/i.test(name)) return 'web';
  if (/mcp| · /.test(name)) return 'mcp';
  return 'other';
}

function toolPresentation(item: TranscriptToolPart): ToolPresentation {
  const input = item.state.input;
  const name = item.tool;
  const kind = toolKind(name);
  const command = inputValue(input, ['command', 'cmd']);
  const path = inputValue(input, ['filePath', 'file_path', 'path']);
  const query = inputValue(input, ['query', 'pattern']);
  const url = inputValue(input, ['url']);
  const description = inputValue(input, ['description', 'name']);
  if (kind === 'command') {
    return { title: 'Shell', subtitle: command || item.state.title, args: [], command, kind };
  }
  if (kind === 'file') {
    const lower = name.toLowerCase();
    const title = /read/.test(lower)
      ? 'Read'
      : /write/.test(lower)
        ? 'Write'
        : /patch|apply/.test(lower)
          ? 'Patch'
          : 'Edit';
    return {
      title,
      subtitle: filename(path) || item.state.title,
      args: primitiveArgs(input, ['filePath', 'file_path', 'path', 'oldString', 'old_string', 'newString', 'new_string', 'content', 'changes']),
      kind,
    };
  }
  if (kind === 'web') {
    return {
      title: url ? 'Fetch' : 'Web search',
      subtitle: url || query || item.state.title,
      args: primitiveArgs(input, ['url', 'query', 'queries', 'pattern']),
      href: url,
      kind,
    };
  }
  if (name === 'task') {
    const agent = inputValue(input, ['subagent_type', 'agent']) || 'Agent';
    const background = input.background === true ? ['background'] : [];
    return {
      title: agent.charAt(0).toUpperCase() + agent.slice(1),
      subtitle: description || item.state.title,
      args: background,
      kind,
    };
  }
  return {
    title: name === 'tool' ? (kind === 'mcp' ? 'MCP' : 'Tool') : name,
    subtitle: description || query || url || item.state.title,
    args: primitiveArgs(input, ['description', 'query', 'url', 'filePath', 'file_path', 'path', 'pattern', 'name']),
    kind,
  };
}

function stringify(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return undefined;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function toolDiff(item: TranscriptToolPart): string | undefined {
  const unified = stringValue(item.state.metadata?.unifiedDiff);
  if (unified) return unified;
  const fileDiff = item.state.metadata?.filediff;
  const fileDiffObject = fileDiff && typeof fileDiff === 'object' && !Array.isArray(fileDiff)
    ? fileDiff as JsonObject
    : undefined;
  const patch = stringValue(fileDiffObject?.patch);
  if (patch) return patch;
  const changes = item.state.input.changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return undefined;
  return Object.entries(changes as JsonObject).map(([path, value]) => {
    const entry = value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
    const diff = stringValue(entry?.diff) || stringValue(entry?.patch) || stringify(value) || '';
    return diff ? `### ${path}\n\n${diff}` : path;
  }).join('\n\n');
}

function diffChanges(diff: string | undefined): { additions: number; deletions: number } | null {
  if (!diff) return null;
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return additions || deletions ? { additions, deletions } : null;
}

function formattedInput(item: TranscriptToolPart, presentation: ToolPresentation): string | undefined {
  if (presentation.kind !== 'mcp' && presentation.kind !== 'other') return undefined;
  const omitted = new Set([
    'command', 'cmd', 'description', 'query', 'url', 'filePath', 'file_path', 'path', 'pattern',
    'name', 'oldString', 'old_string', 'newString', 'new_string', 'content', 'changes',
  ]);
  const rows = Object.entries(item.state.input).flatMap(([key, value]) => {
    if (omitted.has(key)) return [];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return [`${key}: ${String(value)}`];
    }
    if (value === null || value === undefined) return [];
    return [`${key}: ${stringify(value)}`];
  });
  return rows.length ? rows.join('\n') : undefined;
}

interface ToolDiagnostic {
  file: string;
  line?: number;
  character?: number;
  message: string;
}

function toolDiagnostics(item: TranscriptToolPart): ToolDiagnostic[] {
  const value = item.state.metadata?.diagnostics;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as JsonObject).flatMap(([file, entries]) => {
    if (!Array.isArray(entries)) return [];
    return entries.flatMap(entryValue => {
      if (!entryValue || typeof entryValue !== 'object' || Array.isArray(entryValue)) return [];
      const entry = entryValue as JsonObject;
      if (entry.severity !== undefined && entry.severity !== 1) return [];
      const range = entry.range && typeof entry.range === 'object' && !Array.isArray(entry.range) ? entry.range as JsonObject : undefined;
      const start = range?.start && typeof range.start === 'object' && !Array.isArray(range.start) ? range.start as JsonObject : undefined;
      const message = stringValue(entry.message);
      if (!message) return [];
      return [{
        file,
        line: typeof start?.line === 'number' ? start.line + 1 : undefined,
        character: typeof start?.character === 'number' ? start.character + 1 : undefined,
        message,
      }];
    });
  }).slice(0, 3);
}

function isRunning(item: TranscriptToolPart): boolean {
  return item.state.status === 'pending' || item.state.status === 'running';
}

function ToolCard({ item }: { item: TranscriptToolPart }) {
  const { colors } = useTheme();
  const failed = item.state.status === 'error';
  const [expanded, setExpanded] = useState(failed);
  const presentation = toolPresentation(item);
  const diff = toolDiff(item);
  const changes = diffChanges(diff);
  const input = formattedInput(item, presentation);
  const shell = presentation.kind === 'command'
    ? [presentation.command ? `$ ${presentation.command}` : undefined, item.state.output].filter(Boolean).join('\n\n')
    : undefined;
  const error = item.state.error;
  const loaded = Array.isArray(item.state.metadata?.loaded)
    ? item.state.metadata.loaded.filter((value): value is string => typeof value === 'string')
    : [];
  const attachments = item.state.attachments || [];
  const diagnostics = toolDiagnostics(item);
  const hasDetail = Boolean(shell || item.state.output || diff || input || error || loaded.length || attachments.length || diagnostics.length);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      disabled={!hasDetail && !presentation.href}
      className={cn('w-full overflow-hidden', failed && 'rounded-md bg-destructive/10 px-2')}
      onPress={() => {
        if (hasDetail) setExpanded(value => !value);
        else if (presentation.href) Linking.openURL(presentation.href).catch(() => undefined);
      }}
    >
      <View className="min-h-7 flex-row items-center py-1">
        {isRunning(item) && (
          <View className="mr-1.5 size-4 items-center justify-center">
            <ActivityIndicator size={13} color={colors.textTertiary} />
          </View>
        )}
        {failed && (
          <View className="mr-1.5 size-4 items-center justify-center">
            <CircleAlert size={14} color={colors.error} />
          </View>
        )}
        <View className="min-w-0 shrink flex-row items-center gap-1.5">
          <Text numberOfLines={1} className="shrink-0 text-[13px] font-medium leading-5 text-foreground">
            {presentation.title}
          </Text>
          {presentation.subtitle && !isRunning(item) && (
            <>
              <Text className="text-[11px] leading-5 text-muted-foreground">·</Text>
              <Text numberOfLines={1} className="min-w-0 shrink text-[13px] leading-5 text-muted-foreground">
                {presentation.subtitle}
              </Text>
            </>
          )}
          {!isRunning(item) && presentation.args.map(arg => (
            <Text key={arg} numberOfLines={1} className="shrink text-[12px] leading-5 text-muted-foreground">
              {arg}
            </Text>
          ))}
        </View>
        {changes && !isRunning(item) && (
          <View className="ml-2 shrink-0 flex-row gap-1.5">
            <Text className="font-mono text-[11px] leading-5" style={{ color: colors.done }}>+{changes.additions}</Text>
            <Text className="font-mono text-[11px] leading-5" style={{ color: colors.error }}>−{changes.deletions}</Text>
          </View>
        )}
        {presentation.href && !isRunning(item) && (
          <Pressable accessibilityLabel={`Open ${presentation.href}`} className="ml-1 size-7 items-center justify-center" onPress={event => { event.stopPropagation(); Linking.openURL(presentation.href!).catch(() => undefined); }}>
            <ExternalLink size={14} color={colors.textTertiary} />
          </Pressable>
        )}
        {hasDetail && (expanded
          ? <ChevronDown className="ml-1" size={15} color={colors.textTertiary} />
          : <ChevronRight className="ml-1" size={15} color={colors.textTertiary} />)}
      </View>
      {expanded && hasDetail && (
        <View className="mb-3 mt-1 gap-2">
          {shell && <ToolCodeBlock text={shell} bordered />}
          {diff && <ToolDiffBlock diff={diff} />}
          {presentation.kind !== 'command' && item.state.output && <ToolCodeBlock text={item.state.output} />}
          {input && <ToolCodeBlock text={input} muted />}
          {error && <ToolCodeBlock text={error} error />}
          {diagnostics.length > 0 && (
            <View className="gap-1.5 rounded-md bg-destructive/10 px-2.5 py-2">
              {diagnostics.map(diagnostic => (
                <View key={`${diagnostic.file}:${diagnostic.line}:${diagnostic.message}`} className="flex-row gap-2">
                  <Text className="shrink-0 font-mono text-[9px] text-destructive">{filename(diagnostic.file)}{diagnostic.line ? `:${diagnostic.line}${diagnostic.character ? `:${diagnostic.character}` : ''}` : ''}</Text>
                  <Text selectable className="min-w-0 flex-1 text-[10px] leading-4 text-destructive">{diagnostic.message}</Text>
                </View>
              ))}
            </View>
          )}
          {loaded.map(path => <Text key={path} numberOfLines={1} className="px-1 font-mono text-[10px] text-muted-foreground">Loaded {path}</Text>)}
          {attachments.length > 0 && <ToolAttachments files={attachments} />}
        </View>
      )}
    </Pressable>
  );
}

function ToolAttachments({ files }: { files: readonly TranscriptFilePart[] }) {
  const { colors } = useTheme();
  const [preview, setPreview] = useState<TranscriptFilePart | null>(null);
  return (
    <>
      <View className="flex-row flex-wrap gap-2 px-1">
        {files.map(file => file.mime?.startsWith('image/') && file.url ? (
          <Pressable key={file.id} accessibilityLabel={`Preview ${file.filename || 'tool image'}`} className="overflow-hidden rounded-md bg-muted" onPress={() => setPreview(file)}>
            <Image className="h-20 w-28" resizeMode="cover" source={{ uri: file.url }} />
          </Pressable>
        ) : (
          <View key={file.id} className="flex-row items-center gap-1.5 rounded-md bg-muted px-2 py-1.5">
            <File size={12} color={colors.textSecondary} />
            <Text numberOfLines={1} className="max-w-[220px] font-mono text-[9px] text-muted-foreground">{file.filename || file.mime || 'Tool attachment'}</Text>
          </View>
        ))}
      </View>
      <Modal animationType="fade" onRequestClose={() => setPreview(null)} statusBarTranslucent transparent visible={Boolean(preview)}>
        <View className="flex-1 bg-black/95">
          <Pressable accessibilityLabel="Close image preview" className="absolute right-4 top-12 z-10 size-11 items-center justify-center rounded-full bg-white/15" onPress={() => setPreview(null)}><X size={21} color="white" /></Pressable>
          {preview?.url && <Image className="flex-1" resizeMode="contain" source={{ uri: preview.url }} />}
        </View>
      </Modal>
    </>
  );
}

function ToolCodeBlock({
  text,
  bordered = false,
  muted = false,
  error = false,
}: {
  text: string;
  bordered?: boolean;
  muted?: boolean;
  error?: boolean;
}) {
  return (
    <View className={cn('overflow-hidden', bordered && 'rounded-md border border-border')}>
      <ScrollView
        nestedScrollEnabled
        showsVerticalScrollIndicator={false}
        style={TOOL_OUTPUT_SCROLL_STYLE}
        contentContainerClassName={bordered ? 'px-3 py-2.5' : 'px-1 py-1'}
      >
        <Text
          selectable
          className={cn(
            'font-mono text-[11px] leading-[17px] text-foreground',
            muted && 'text-muted-foreground',
            error && 'text-destructive',
          )}
        >
          {text}
        </Text>
      </ScrollView>
    </View>
  );
}

function ToolDiffBlock({ diff }: { diff: string }) {
  const { colors } = useTheme();
  const lines = diff.split('\n');
  return (
    <View className="overflow-hidden border-t border-border pt-2">
      <ScrollView nestedScrollEnabled showsVerticalScrollIndicator={false} style={TOOL_DIFF_SCROLL_STYLE} contentContainerClassName="px-1">
        <Text selectable className="font-mono text-[11px] leading-[17px] text-foreground">
          {lines.map((line, index) => (
            <Text
              key={`${index}:${line}`}
              style={{
                color: line.startsWith('+') && !line.startsWith('+++')
                  ? colors.done
                  : line.startsWith('-') && !line.startsWith('---')
                    ? colors.error
                    : colors.text,
              }}
            >
              {line}{index < lines.length - 1 ? '\n' : ''}
            </Text>
          ))}
        </Text>
      </ScrollView>
    </View>
  );
}

function isContextTool(part: TranscriptPart): part is TranscriptToolPart {
  return part.type === 'tool' && /^(?:read|list|glob|grep)$/i.test(part.tool);
}

function contextSummary(tools: readonly TranscriptToolPart[]): string {
  const counts = [
    ['read', tools.filter(tool => tool.tool === 'read').length],
    ['search', tools.filter(tool => /^(?:glob|grep)$/i.test(tool.tool)).length],
    ['list', tools.filter(tool => tool.tool === 'list').length],
  ] as const;
  const labels = counts.flatMap(([label, count]) => count ? [`${count} ${label}${count === 1 ? '' : 's'}`] : []);
  return labels.length ? labels.join(' · ') : `${tools.length} operation${tools.length === 1 ? '' : 's'}`;
}

function ContextToolGroup({ tools }: { tools: TranscriptToolPart[] }) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const running = tools.some(isRunning);
  const failed = tools.some(tool => tool.state.status === 'error');
  return (
    <View className="w-full">
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} className="min-h-8 flex-row items-center py-1" onPress={() => setExpanded(value => !value)}>
        {running && <ActivityIndicator className="mr-2" size={13} color={colors.textTertiary} />}
        {failed && !running && <CircleAlert className="mr-2" size={14} color={colors.error} />}
        <Text className="text-[13px] font-medium text-foreground">{running ? 'Gathering context' : 'Gathered context'}</Text>
        <Text numberOfLines={1} className="ml-1.5 min-w-0 shrink text-[12px] text-muted-foreground">{contextSummary(tools)}</Text>
        {expanded ? <ChevronDown className="ml-1" size={15} color={colors.textTertiary} /> : <ChevronRight className="ml-1" size={15} color={colors.textTertiary} />}
      </Pressable>
      {expanded && <View className="ml-3 border-l border-border pl-3">{tools.map(tool => <ToolCard key={tool.id} item={tool} />)}</View>}
    </View>
  );
}

type PartGroup = { type: 'part'; part: TranscriptPart } | { type: 'context'; id: string; tools: TranscriptToolPart[] };

function groupParts(parts: readonly TranscriptPart[]): PartGroup[] {
  const groups: PartGroup[] = [];
  let context: TranscriptToolPart[] = [];
  const flush = () => {
    if (!context.length) return;
    groups.push({ type: 'context', id: `context:${context[0].id}`, tools: context });
    context = [];
  };
  for (const part of parts) {
    if (isContextTool(part)) {
      context.push(part);
      continue;
    }
    flush();
    groups.push({ type: 'part', part });
  }
  flush();
  return groups;
}

function renderablePart(part: TranscriptPart): boolean {
  if (part.type === 'text' || part.type === 'reasoning') return Boolean(part.text.trim()) && !('synthetic' in part && (part.synthetic || part.ignored));
  if (part.type === 'tool') {
    if (part.tool === 'todowrite') return false;
    if (part.tool === 'question' && isRunning(part)) return false;
    return true;
  }
  return part.type === 'compaction' || part.type === 'plan' || part.type === 'notice' || part.type === 'subtask';
}

function AssistantPart({ part, onLinkPress }: { part: TranscriptPart; onLinkPress: (url: string) => void }) {
  const { colors } = useTheme();
  if (part.type === 'text') {
    if (!part.text.trim() || part.synthetic || part.ignored) return null;
    return <View className="min-w-0 w-full"><MarkdownText content={part.text} onLinkPress={({ url }) => onLinkPress(url)} /></View>;
  }
  if (part.type === 'reasoning') {
    if (!part.text.trim()) return null;
    return (
      <View className="w-full border-l border-border pl-3 py-0.5">
        <Text className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Thinking</Text>
        <MarkdownText content={part.text} onLinkPress={({ url }) => onLinkPress(url)} />
      </View>
    );
  }
  if (part.type === 'tool') return <ToolCard item={part} />;
  if (part.type === 'compaction') {
    return (
      <View className="my-2 flex-row items-center gap-2">
        <View className="h-px flex-1 bg-border" />
        <Text className="text-[10px] text-muted-foreground">Compacted conversation</Text>
        <View className="h-px flex-1 bg-border" />
      </View>
    );
  }
  if (part.type === 'plan') {
    return <View className="w-full py-1"><Text className="mb-2 text-[13px] font-medium leading-5 text-foreground">Plan</Text><MarkdownText content={part.text} onLinkPress={({ url }) => onLinkPress(url)} /></View>;
  }
  if (part.type === 'notice') {
    return (
      <View className={cn('w-full flex-row gap-2 rounded-md px-3 py-2.5', part.level === 'error' ? 'bg-destructive/10' : 'bg-muted')}>
        {part.level === 'error' && <CircleAlert size={15} color={colors.error} />}
        <Text selectable className="min-w-0 flex-1 text-[12px] leading-[18px] text-muted-foreground">{part.text}</Text>
      </View>
    );
  }
  if (part.type === 'subtask') {
    return <View className="w-full border-l border-border py-1 pl-3"><Text className="text-[13px] font-medium text-foreground">Task · {part.agent || 'agent'}</Text>{part.description && <Text className="mt-0.5 text-[12px] text-muted-foreground">{part.description}</Text>}</View>;
  }
  return null;
}

function visibleUserText(message: TranscriptMessage | undefined): string {
  return message?.parts
    .filter(part => part.type === 'text' && !part.synthetic && !part.ignored)
    .map(part => part.type === 'text' ? part.text : '')
    .filter(Boolean)
    .join('\n') || '';
}

function userFiles(message: TranscriptMessage | undefined): TranscriptFilePart[] {
  return message?.parts.filter((part): part is TranscriptFilePart => part.type === 'file') || [];
}

function sourceRange(part: TranscriptPart): { start: number; end: number } | null {
  if (part.type !== 'file' && part.type !== 'agent') return null;
  const source = part.source;
  if (!source) return null;
  const range = part.type === 'file' && source.text && typeof source.text === 'object' && !Array.isArray(source.text)
    ? source.text as JsonObject
    : source;
  const start = range.start;
  const end = range.end;
  return typeof start === 'number' && typeof end === 'number' && start >= 0 && end > start ? { start, end } : null;
}

function isInlineFile(part: TranscriptFilePart): boolean {
  return sourceRange(part) !== null && !part.url?.startsWith('data:');
}

function PromptText({ message, text }: { message: TranscriptMessage; text: string }) {
  const refs = message.parts.flatMap(part => {
    const range = sourceRange(part);
    return range && range.start < text.length
      ? [{ ...range, end: Math.min(range.end, text.length), type: part.type }]
      : [];
  }).sort((left, right) => left.start - right.start);
  if (!refs.length) return <Text selectable className="text-[14px] leading-[20px] text-foreground">{text}</Text>;
  const segments: Array<{ text: string; highlighted?: boolean }> = [];
  let cursor = 0;
  for (const ref of refs) {
    if (ref.start < cursor) continue;
    if (ref.start > cursor) segments.push({ text: text.slice(cursor, ref.start) });
    segments.push({ text: text.slice(ref.start, ref.end), highlighted: true });
    cursor = ref.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return (
    <Text selectable className="text-[14px] leading-[20px] text-foreground">
      {segments.map((segment, index) => (
        <Text key={`${index}:${segment.text}`} className={segment.highlighted ? 'font-semibold text-primary' : ''}>{segment.text}</Text>
      ))}
    </Text>
  );
}

function formatTime(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  try { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return undefined; }
}

function formatDuration(start: number | undefined, end: number | undefined): string | undefined {
  if (start === undefined || end === undefined || end < start) return undefined;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function UserPrompt({ message }: { message: TranscriptMessage }) {
  const { colors } = useTheme();
  const [copied, setCopied] = useState(false);
  const [preview, setPreview] = useState<TranscriptFilePart | null>(null);
  const text = visibleUserText(message);
  const files = userFiles(message).filter(file => !isInlineFile(file));
  const agents = message.parts.filter(part => part.type === 'agent');
  if (!text && !files.length && !agents.length) return null;
  const meta = [message.agent, message.modelId, formatTime(message.createdAt)].filter(Boolean).join(' · ');
  return (
    <View className="ml-9 items-end">
      {files.length > 0 && (
        <View className="mb-1.5 flex-row flex-wrap justify-end gap-1.5">
          {files.map(file => file.mime?.startsWith('image/') && file.url ? (
            <Pressable key={file.id} accessibilityLabel={`Preview ${file.filename || 'image'}`} className="overflow-hidden rounded-lg bg-muted" onPress={() => setPreview(file)}>
              <Image className="h-24 w-32" resizeMode="cover" source={{ uri: file.url }} />
            </Pressable>
          ) : (
            <View key={file.id} className="flex-row items-center gap-1.5 rounded-md bg-muted px-2 py-1.5">
              <File size={12} color={colors.textSecondary} />
              <View className="min-w-0"><Text numberOfLines={1} className="max-w-[220px] font-mono text-[9px] text-muted-foreground">{file.filename || file.mime || 'Attachment'}</Text>{file.mime && <Text className="mt-0.5 text-[8px] uppercase text-muted-foreground">{file.mime}</Text>}</View>
            </View>
          ))}
        </View>
      )}
      {text && (
        <Pressable accessibilityLabel="Copy prompt" className="max-w-[86%] rounded-xl bg-muted px-3 py-2.5" onLongPress={() => Clipboard.setString(text)}>
          <PromptText message={message} text={text} />
        </Pressable>
      )}
      {(meta || text) && (
        <View className="mt-1 flex-row items-center gap-1 px-1">
          {meta && <Text className="text-[9px] text-muted-foreground">{meta}</Text>}
          {text && <Button accessibilityLabel="Copy prompt" className="size-6 rounded-full px-0" variant="ghost" onPress={() => { Clipboard.setString(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? <Check size={11} color={colors.done} /> : <Copy size={11} color={colors.textTertiary} />}</Button>}
        </View>
      )}
      <Modal animationType="fade" onRequestClose={() => setPreview(null)} statusBarTranslucent transparent visible={Boolean(preview)}>
        <View className="flex-1 bg-black/95">
          <Pressable accessibilityLabel="Close image preview" className="absolute right-4 top-12 z-10 size-11 items-center justify-center rounded-full bg-white/15" onPress={() => setPreview(null)}><X size={21} color="white" /></Pressable>
          {preview?.url && <Image className="flex-1" resizeMode="contain" source={{ uri: preview.url }} />}
        </View>
      </Modal>
    </View>
  );
}

function assistantCopyText(turn: TranscriptTurn): string {
  return turn.assistants.flatMap(message => message.parts).flatMap(part => {
    if (part.type === 'text' && !part.synthetic && !part.ignored) return [part.text];
    return [];
  }).join('\n\n');
}

function TurnMeta({ turn }: { turn: TranscriptTurn }) {
  const { colors } = useTheme();
  const [copied, setCopied] = useState(false);
  const duration = formatDuration(turn.startedAt, turn.completedAt);
  const total = turn.tokens?.total;
  const values = [
    duration,
    total !== undefined ? `${total.toLocaleString()} tokens` : undefined,
    turn.cost !== undefined ? `$${turn.cost.toFixed(turn.cost < 0.01 ? 4 : 2)}` : undefined,
    turn.status === 'interrupted' ? 'Interrupted' : undefined,
  ].filter(Boolean);
  const copy = assistantCopyText(turn);
  if (!values.length && !copy) return null;
  return (
    <View className="mt-2 min-h-7 flex-row items-center gap-2">
      {values.length > 0 && <Text className="text-[10px] text-muted-foreground">{values.join(' · ')}</Text>}
      {copy && (
        <Button
          accessibilityLabel="Copy response"
          className="ml-auto size-7 rounded-full px-0"
          variant="ghost"
          onPress={() => {
            Clipboard.setString(copy);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check size={13} color={colors.done} /> : <Copy size={13} color={colors.textTertiary} />}
        </Button>
      )}
    </View>
  );
}

function ChangedFiles({ turn }: { turn: TranscriptTurn }) {
  if (!turn.diffs.length) return null;
  const additions = turn.diffs.reduce((total, diff) => total + (diff.additions || 0), 0);
  const deletions = turn.diffs.reduce((total, diff) => total + (diff.deletions || 0), 0);
  return (
    <View className="mt-2 border-t border-border pt-2">
      <Text className="text-[11px] font-medium text-foreground">Changed {turn.diffs.length} file{turn.diffs.length === 1 ? '' : 's'}</Text>
      <Text className="mt-0.5 font-mono text-[10px] text-muted-foreground">+{additions} −{deletions}</Text>
      {turn.diffs.slice(0, 10).map(diff => <Text key={diff.file} numberOfLines={1} className="mt-1 font-mono text-[10px] text-muted-foreground">{diff.file}</Text>)}
    </View>
  );
}

const TranscriptTurnView = memo(function TranscriptTurnRow({ turn, onLinkPress }: { turn: TranscriptTurn; onLinkPress: (url: string) => void }) {
  const { colors } = useTheme();
  const parts = useMemo(() => groupParts(turn.assistants.flatMap(message => message.parts).filter(renderablePart)), [turn.assistants]);
  return (
    <View className="w-full">
      {turn.user && <UserPrompt message={turn.user} />}
      <View className={cn('w-full gap-3', turn.user && 'mt-3')}>
        {parts.map(group => group.type === 'context'
          ? <ContextToolGroup key={group.id} tools={group.tools} />
          : <AssistantPart key={group.part.id} part={group.part} onLinkPress={onLinkPress} />)}
        {turn.status === 'working' && !parts.length && (
          <View className="flex-row items-center gap-2 py-1"><ActivityIndicator size={13} color={colors.textTertiary} /><Text className="text-[12px] text-muted-foreground">Thinking…</Text></View>
        )}
        {turn.assistants.flatMap(message => message.error ? [message.error] : []).map((error, index) => (
          <View key={`error:${index}`} className="flex-row gap-2 rounded-md bg-destructive/10 px-3 py-2.5"><CircleAlert size={15} color={colors.error} /><Text selectable className="min-w-0 flex-1 text-[12px] leading-[18px] text-muted-foreground">{stringify(error) || 'Agent error'}</Text></View>
        ))}
      </View>
      <ChangedFiles turn={turn} />
      <TurnMeta turn={turn} />
    </View>
  );
});

export function AgentChatView({
  state,
  agent,
  attachments,
  draft,
  queue,
  sending,
  onOpenTerminal,
  onAttach,
  onDraftChange,
  onOpenFile,
  onRemoveAttachment,
  onSubmit,
}: Props) {
  const { colors } = useTheme();
  const safeAreaInsets = useSafeAreaInsets();
  const [text, setText] = useState(draft);
  const [atBottom, setAtBottom] = useState(true);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const turns = state.transcript.turns;
  const list = useRef<FlatList<TranscriptTurn>>(null);
  const composerInput = useRef<TextInputHandle>(null);
  const composerContainer = useRef<View | null>(null);
  const previousCount = useRef(0);
  const draftRef = useRef(draft);
  const { inset: keyboardInset } = useKeyboardInset(composerContainer, { enabled: Platform.OS === 'android' });
  const agentName = agent === 'opencode' ? 'OpenCode' : 'Codex';

  useEffect(() => {
    if (draft === draftRef.current) return;
    draftRef.current = draft;
    setText(draft);
    composerInput.current?.setNativeProps({ text: draft });
    composerInput.current?.setSelection(draft.length, draft.length);
  }, [draft]);

  useEffect(() => {
    if (turns.length > previousCount.current && atBottom) requestAnimationFrame(() => list.current?.scrollToEnd({ animated: true }));
    previousCount.current = turns.length;
  }, [atBottom, turns.length]);

  const trackScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    setAtBottom(contentSize.height - (contentOffset.y + layoutMeasurement.height) < 72);
  };
  const submit = async () => {
    const value = draftRef.current;
    if (sending || (!value.trim() && !attachments.length)) return;
    if (await onSubmit(value)) {
      draftRef.current = '';
      setText('');
      onDraftChange('');
      composerInput.current?.clear();
    }
  };
  const updateText = (value: string) => {
    draftRef.current = value;
    setText(value);
    onDraftChange(value);
  };
  const openTranscriptLink = useCallback((url: string) => {
    const file = transcriptFileLinkTarget(url, state.transcript.info?.directory);
    if (file) {
      onOpenFile(file);
      return;
    }
    if (/^(?:https?:|mailto:|tel:)/i.test(url)) Linking.openURL(url).catch(() => undefined);
  }, [onOpenFile, state.transcript.info?.directory]);

  return (
    <KeyboardAvoidingView className="flex-1 bg-background" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {state.status !== 'live' && (
        <View className="flex-row items-center gap-2 px-4 py-3">
          {state.status === 'loading' ? <ActivityIndicator size="small" color={colors.primary} /> : <CircleAlert size={14} color={colors.textSecondary} />}
          <Text numberOfLines={2} className="min-w-0 flex-1 text-[12px] text-muted-foreground">
            {state.error || (state.status === 'loading' ? `Reading the local ${agentName} history…` : 'The transcript is temporarily unavailable.')}
          </Text>
        </View>
      )}
      <View className="relative flex-1">
        <FlatList
          ref={list}
          data={turns}
          keyExtractor={turn => turn.id}
          renderItem={({ item, index }) => <View className={index === 0 ? '' : 'mt-7'}><TranscriptTurnView turn={item} onLinkPress={openTranscriptLink} /></View>}
          contentContainerClassName="flex-grow px-4 pb-6 pt-4"
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={state.status === 'live' ? (
            <View className="flex-1 items-center justify-center px-8 py-20">
              <Text className="text-center text-[14px] font-semibold text-foreground">No conversation yet</Text>
              <Text className="mt-1 max-w-[280px] text-center text-[12px] leading-[18px] text-muted-foreground">Send a message below, or switch to the terminal to continue there.</Text>
            </View>
          ) : null}
          onScroll={trackScroll}
          scrollEventThrottle={80}
        />
        {!atBottom && (
          <Button accessibilityLabel="Jump to latest" className="absolute bottom-3 right-4 h-8 flex-row gap-1.5 rounded-full px-3 shadow-lg" variant="secondary" onPress={() => list.current?.scrollToEnd({ animated: true })}>
            <ChevronDown size={15} color={colors.text} /><Text className="text-[10px] font-semibold">Latest</Text>
          </Button>
        )}
      </View>
      {!composerExpanded && (
        <View ref={composerContainer} collapsable={false} className="relative z-10 bg-background px-3 pb-2 pt-2" style={keyboardInset > 0 ? { transform: [{ translateY: -keyboardInset }] } : undefined}>
          <MessageComposer
            initialValue={text}
            inputRef={composerInput}
            onChangeText={updateText}
            multiline
            textAlignVertical="top"
            placeholder={`Message ${agentName}…`}
            placeholderTextColor={colors.textTertiary}
            numberOfLines={3}
            inputClassName="h-[76px] px-4 py-3 text-[13px] leading-[19px] dark:bg-transparent"
            surfaceClassName="rounded-[38px] bg-card"
            actions={{
              actionClassName: 'bg-muted', actionColor: colors.text, attachLabel: 'Attach file', closeLabel: 'Close chat composer', expandLabel: 'Expand composer',
              onAttach, onClose: onOpenTerminal, onExpand: () => setComposerExpanded(true), onSend: submit,
              sendColor: colors.onPrimary, sendDisabled: sending || (!text.trim() && !attachments.length), sendLabel: 'Send message', sending,
            }}
            beforeInput={<><ChatQueueStrip messages={queue} /><ChatAttachmentsStrip attachments={attachments} onRemoveAttachment={onRemoveAttachment} /></>}
          />
        </View>
      )}
      {composerExpanded && (
        <Modal animationType="slide" onRequestClose={() => setComposerExpanded(false)} statusBarTranslucent visible>
          <View className="flex-1 bg-background" style={{ paddingTop: safeAreaInsets.top, paddingBottom: safeAreaInsets.bottom }}>
            <View className="h-14 flex-row items-center gap-2 border-b border-border bg-card px-2">
              <Button accessibilityLabel="Collapse composer" className="size-10 rounded-full px-0" variant="ghost" onPress={() => setComposerExpanded(false)}><Minimize2 size={19} color={colors.text} /></Button>
              <View className="min-w-0 flex-1"><Text className="text-[13px] font-bold text-foreground">New {agentName} message</Text><Text className="text-[9px] text-muted-foreground">{attachments.length ? `${attachments.length} attachment${attachments.length === 1 ? '' : 's'}` : `${text.length.toLocaleString()} characters`}</Text></View>
              <Button accessibilityLabel="Send message" className="h-10 flex-row gap-2 rounded-full px-4" disabled={sending || (!text.trim() && !attachments.length)} onPress={submit}>
                {sending ? <ActivityIndicator size="small" color={colors.onPrimary} /> : <Send size={16} color={colors.onPrimary} />}<Text className="text-[11px] font-bold text-primary-foreground">SEND</Text>
              </Button>
            </View>
            <ChatAttachmentsStrip attachments={attachments} expanded onRemoveAttachment={onRemoveAttachment} />
            <ChatQueueStrip messages={queue} expanded />
            <ComposerInput ref={composerInput} initialValue={text} autoFocus multiline textAlignVertical="top" onChangeText={updateText} placeholder={`Message ${agentName}…`} placeholderTextColor={colors.textTertiary} className="h-auto min-h-0 flex-1 rounded-none border-0 bg-transparent px-4 py-4 text-[15px] leading-[22px] shadow-none" />
            <View className="h-14 flex-row items-center border-t border-border bg-card px-2">
              <Button accessibilityLabel="Attach file" className="size-10 rounded-full px-0" variant="ghost" onPress={onAttach}><Paperclip size={19} color={colors.text} /></Button>
              <Text className="ml-auto px-2 text-[9px] text-muted-foreground">{text.length.toLocaleString()} characters</Text>
            </View>
          </View>
        </Modal>
      )}
    </KeyboardAvoidingView>
  );
}

function ChatQueueStrip({ messages, expanded = false }: { messages: readonly TerminalComposerQueueItem[]; expanded?: boolean }) {
  if (!messages.length) return null;
  return (
    <View className={expanded ? 'border-b border-border px-3 py-3' : 'border-b border-border px-2.5 py-2'}>
      <Text className="mb-1.5 text-[9px] font-bold uppercase tracking-widest text-muted-foreground">Outbox · {messages.length}</Text>
      <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2">
        {messages.map(message => (
          <View key={message.id} className="h-11 w-52 justify-center rounded-md border border-border bg-muted px-2.5">
            <Text numberOfLines={1} className="text-[10px] text-foreground">{message.historyEntry}</Text>
            <Text className="text-[8px] text-muted-foreground">{message.sending ? 'Sending' : message.error ? 'Retrying' : 'Queued until connected'}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function ChatAttachmentsStrip({
  attachments,
  expanded = false,
  onRemoveAttachment,
}: {
  attachments: readonly string[];
  expanded?: boolean;
  onRemoveAttachment: (path: string) => void;
}) {
  const { colors } = useTheme();
  if (attachments.length === 0) return null;
  return (
    <View className={expanded ? 'flex-row flex-wrap gap-2 border-b border-border px-3 py-3' : 'flex-row flex-wrap gap-1.5 border-b border-border px-2.5 py-2'}>
      {attachments.map(path => (
        <Pressable key={path} accessibilityLabel={`Remove ${path.split('/').pop()}`} className="flex-row items-center gap-1.5 rounded-md bg-muted px-2 py-1.5 active:opacity-70" onPress={() => onRemoveAttachment(path)}>
          <File size={12} color={colors.textSecondary} />
          <Text numberOfLines={1} className="max-w-[240px] font-mono text-[9px] text-muted-foreground">{path.split('/').pop()}</Text>
          <X size={11} color={colors.textSecondary} />
        </Pressable>
      ))}
    </View>
  );
}
