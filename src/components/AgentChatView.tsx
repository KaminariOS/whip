import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  File,
  Minimize2,
  Paperclip,
  Send,
  X,
} from 'lucide-react-native';
import {
  ActivityIndicator,
  FlatList,
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

import type { AgentChatItem, AgentChatState } from '../agentChat';
import { useKeyboardInset } from '../hooks/useKeyboardInset';
import type { ChatAgent } from '../lib/agentChatSession';
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
  onRemoveAttachment: (path: string) => void;
  onSubmit: (text: string) => Promise<boolean>;
}

type ToolItem = Extract<AgentChatItem, { type: 'tool' }>;

function toolDetailLabel(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  try {
    const value = JSON.parse(detail) as Record<string, unknown>;
    for (const key of ['description', 'query', 'url', 'filePath', 'path', 'pattern', 'name', 'command', 'cmd']) {
      const candidate = value[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
      if (Array.isArray(candidate)) {
        const command = candidate.filter(part => typeof part === 'string').join(' ');
        if (command) return command;
      }
    }
  } catch {
    const line = detail.trim().split('\n', 1)[0];
    if (line && !line.startsWith('{') && !line.startsWith('[')) return line;
  }
  return undefined;
}

function toolPresentation(item: ToolItem): { title: string; subtitle?: string } {
  const detail = toolDetailLabel(item.detail);
  if (item.toolKind === 'command') {
    const genericCommand = /^(?:command|exec|shell|bash)$/i.test(item.title);
    return {
      title: item.status === 'running' ? 'Running' : item.status === 'failed' ? 'Command failed' : 'Ran',
      subtitle: genericCommand ? detail : item.title,
    };
  }
  if (item.toolKind === 'file') {
    return {
      title: item.status === 'running' ? 'Editing files' : item.status === 'failed' ? 'Edit failed' : 'Edited files',
      subtitle: item.title === 'File changes' ? detail : item.title,
    };
  }
  if (item.toolKind === 'web') {
    return {
      title: item.status === 'running' ? 'Searching web' : item.status === 'failed' ? 'Search failed' : 'Searched web',
      subtitle: item.title === 'Web search' ? detail : item.title,
    };
  }
  const name = item.title === 'Tool' ? 'tool' : item.title;
  return {
    title: item.status === 'running' ? `Calling ${name}` : item.status === 'failed' ? `${name} failed` : `Called ${name}`,
    subtitle: detail,
  };
}

function chatItemSpacing(items: readonly AgentChatItem[], index: number): string {
  if (index === 0) return '';
  const item = items[index];
  const previous = items[index - 1];
  if (item?.type === 'user-message') return 'mt-6';
  if (previous?.type === 'user-message') return 'mt-3';
  if (item?.type === 'tool' && previous?.type === 'tool') return 'mt-1';
  return 'mt-3';
}

function ToolCard({
  item,
}: {
  item: ToolItem;
}) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(item.status === 'failed');
  const hasDetail = Boolean(item.detail || item.output || item.diff);
  const presentation = toolPresentation(item);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      disabled={!hasDetail}
      className="w-full overflow-hidden"
      onPress={() => setExpanded(value => !value)}
    >
      <View className="h-8 flex-row items-center">
        {item.status === 'running' && (
          <View className="mr-2 size-4 items-center justify-center">
            <ActivityIndicator size={14} color={colors.textTertiary} />
          </View>
        )}
        {item.status === 'failed' && (
          <View className="mr-2 size-4 items-center justify-center">
            <CircleAlert size={14} color={colors.error} />
          </View>
        )}
        <Text
          numberOfLines={1}
          className={cn(
            'shrink-0 text-[13px] font-medium leading-5 text-foreground',
            item.status === 'failed' && 'text-destructive',
          )}
        >
          {presentation.title}
        </Text>
        {presentation.subtitle && (
          <Text
            numberOfLines={1}
            className="ml-2 min-w-0 flex-1 text-[13px] leading-5 text-muted-foreground"
          >
            {presentation.subtitle}
          </Text>
        )}
        {hasDetail &&
          (expanded ? (
            <ChevronDown size={15} color={colors.textTertiary} />
          ) : (
            <ChevronRight size={15} color={colors.textTertiary} />
          ))}
      </View>
      {expanded && hasDetail && (
        <View className="mb-3 mt-1 gap-3">
          {item.detail && (
            <Text
              selectable
              className="px-1 font-mono text-[11px] leading-[17px] text-muted-foreground"
            >
              {item.detail}
            </Text>
          )}
          {item.output && (
            <View className="overflow-hidden rounded-md border border-border px-3 py-2.5">
              <Text
                selectable
                className="font-mono text-[11px] leading-[17px] text-foreground"
              >
                {item.output}
              </Text>
            </View>
          )}
          {item.diff && (
            <View className="overflow-hidden rounded-md border border-border px-3 py-2.5">
              <Text
                selectable
                className="font-mono text-[11px] leading-[17px] text-foreground"
              >
                {item.diff}
              </Text>
            </View>
          )}
        </View>
      )}
    </Pressable>
  );
}

function ChatItem({ item }: { item: AgentChatItem }) {
  const { colors } = useTheme();
  if (item.type === 'user-message') {
    return (
      <View className="ml-9 items-end">
        <View className="max-w-[82%] rounded-xl bg-muted px-3 py-2.5">
          <Text
            selectable
            className="text-[14px] leading-[20px] text-foreground"
          >
            {item.text}
          </Text>
        </View>
      </View>
    );
  }
  if (item.type === 'assistant-message') {
    return (
      // A vertical FlatList item must keep content-based height. `flex-1`
      // collapses its basis while the native markdown view still paints,
      // causing later tool rows to overlap the message on Android.
      <View className="min-w-0 w-full">
        <MarkdownText
          content={item.text}
          onLinkPress={({ url }) => {
            if (/^(?:https?:|mailto:|tel:)/i.test(url))
              Linking.openURL(url).catch(() => undefined);
          }}
        />
      </View>
    );
  }
  if (item.type === 'tool') return <ToolCard item={item} />;
  if (item.type === 'plan') {
    return (
      <View className="w-full py-1">
        <Text className="mb-2 text-[13px] font-medium leading-5 text-foreground">
          Plan
        </Text>
        <MarkdownText content={item.text} />
      </View>
    );
  }
  if (item.type === 'reasoning-summary') {
    return (
      <Text
        selectable
        className="w-full text-[13px] leading-5 text-muted-foreground"
      >
        {item.text}
      </Text>
    );
  }
  return (
    <View className="w-full flex-row gap-2 rounded-md bg-destructive/10 px-3 py-2.5">
      <CircleAlert size={15} color={colors.error} />
      <Text
        selectable
        className="min-w-0 flex-1 text-[12px] leading-[18px] text-muted-foreground"
      >
        {item.text}
      </Text>
    </View>
  );
}

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
  onRemoveAttachment,
  onSubmit,
}: Props) {
  const { colors } = useTheme();
  const safeAreaInsets = useSafeAreaInsets();
  const [text, setText] = useState(draft);
  const [atBottom, setAtBottom] = useState(true);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const list = useRef<FlatList<AgentChatItem>>(null);
  const composerInput = useRef<TextInputHandle>(null);
  const composerContainer = useRef<View | null>(null);
  const previousCount = useRef(0);
  const draftRef = useRef(draft);
  const { inset: keyboardInset } = useKeyboardInset(composerContainer, {
    enabled: Platform.OS === 'android',
  });
  const agentName = agent === 'opencode' ? 'OpenCode' : 'Codex';

  useEffect(() => {
    if (draft === draftRef.current) return;
    draftRef.current = draft;
    setText(draft);
    composerInput.current?.setNativeProps({ text: draft });
    composerInput.current?.setSelection(draft.length, draft.length);
  }, [draft]);

  useEffect(() => {
    if (state.items.length > previousCount.current && atBottom)
      requestAnimationFrame(() =>
        list.current?.scrollToEnd({ animated: true }),
      );
    previousCount.current = state.items.length;
  }, [atBottom, state.items.length]);

  const trackScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    setAtBottom(
      contentSize.height - (contentOffset.y + layoutMeasurement.height) < 72,
    );
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

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-background"
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {state.status !== 'live' && (
        <View className="flex-row items-center gap-2 px-4 py-3">
          {state.status === 'loading' ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <CircleAlert size={14} color={colors.textSecondary} />
          )}
          <Text
            numberOfLines={2}
            className="min-w-0 flex-1 text-[12px] text-muted-foreground"
          >
            {state.error ||
              (state.status === 'loading'
                ? `Reading the local ${agentName} history…`
                : 'The transcript is temporarily unavailable.')}
          </Text>
        </View>
      )}
      <View className="relative flex-1">
        <FlatList
          ref={list}
          data={state.items as AgentChatItem[]}
          keyExtractor={item => item.id}
          renderItem={({ item, index }) => (
            <View className={chatItemSpacing(state.items, index)}>
              <ChatItem item={item} />
            </View>
          )}
          contentContainerClassName="flex-grow px-4 pb-6 pt-4"
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            state.status === 'live' ? (
              <View className="flex-1 items-center justify-center px-8 py-20">
                <Text className="text-center text-[14px] font-semibold text-foreground">
                  No conversation yet
                </Text>
                <Text className="mt-1 max-w-[280px] text-center text-[12px] leading-[18px] text-muted-foreground">
                  Send a message below, or switch to the terminal to continue
                  there.
                </Text>
              </View>
            ) : null
          }
          onScroll={trackScroll}
          scrollEventThrottle={80}
        />
        {!atBottom && (
          <Button
            accessibilityLabel="Jump to latest"
            className="absolute bottom-3 right-4 h-8 flex-row gap-1.5 rounded-full px-3 shadow-lg"
            variant="secondary"
            onPress={() => list.current?.scrollToEnd({ animated: true })}
          >
            <ChevronDown size={15} color={colors.text} />
            <Text className="text-[10px] font-semibold">Latest</Text>
          </Button>
        )}
      </View>
      {!composerExpanded && (
        <View
          ref={composerContainer}
          collapsable={false}
          className="relative z-10 bg-background px-3 pb-2 pt-2"
          style={keyboardInset > 0 ? { transform: [{ translateY: -keyboardInset }] } : undefined}
        >
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
              actionClassName: 'bg-muted',
              actionColor: colors.text,
              attachLabel: 'Attach file',
              closeLabel: 'Close chat composer',
              expandLabel: 'Expand composer',
              onAttach,
              onClose: onOpenTerminal,
              onExpand: () => setComposerExpanded(true),
              onSend: submit,
              sendColor: colors.onPrimary,
              sendDisabled: sending || (!text.trim() && !attachments.length),
              sendLabel: 'Send message',
              sending,
            }}
            beforeInput={(
              <>
                <ChatQueueStrip messages={queue} />
                <ChatAttachmentsStrip
                  attachments={attachments}
                  onRemoveAttachment={onRemoveAttachment}
                />
              </>
            )}
          />
        </View>
      )}
      {composerExpanded && (
        <Modal
          animationType="slide"
          onRequestClose={() => setComposerExpanded(false)}
          statusBarTranslucent
          visible
        >
          <View
            className="flex-1 bg-background"
            style={{
              paddingTop: safeAreaInsets.top,
              paddingBottom: safeAreaInsets.bottom,
            }}
          >
            <View className="h-14 flex-row items-center gap-2 border-b border-border bg-card px-2">
              <Button
                accessibilityLabel="Collapse composer"
                className="size-10 rounded-full px-0"
                variant="ghost"
                onPress={() => setComposerExpanded(false)}
              >
                <Minimize2 size={19} color={colors.text} />
              </Button>
              <View className="min-w-0 flex-1">
                <Text className="text-[13px] font-bold text-foreground">
                  New {agentName} message
                </Text>
                <Text className="text-[9px] text-muted-foreground">
                  {attachments.length
                    ? `${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`
                    : `${text.length.toLocaleString()} characters`}
                </Text>
              </View>
              <Button
                accessibilityLabel="Send message"
                className="h-10 flex-row gap-2 rounded-full px-4"
                disabled={sending || (!text.trim() && !attachments.length)}
                onPress={submit}
              >
                {sending ? (
                  <ActivityIndicator size="small" color={colors.onPrimary} />
                ) : (
                  <Send size={16} color={colors.onPrimary} />
                )}
                <Text className="text-[11px] font-bold text-primary-foreground">
                  SEND
                </Text>
              </Button>
            </View>
            <ChatAttachmentsStrip
              attachments={attachments}
              expanded
              onRemoveAttachment={onRemoveAttachment}
            />
            <ChatQueueStrip messages={queue} expanded />
            <ComposerInput
              ref={composerInput}
              initialValue={text}
              autoFocus
              multiline
              textAlignVertical="top"
              onChangeText={updateText}
              placeholder={`Message ${agentName}…`}
              placeholderTextColor={colors.textTertiary}
              className="h-auto min-h-0 flex-1 rounded-none border-0 bg-transparent px-4 py-4 text-[15px] leading-[22px] shadow-none"
            />
            <View className="h-14 flex-row items-center border-t border-border bg-card px-2">
              <Button
                accessibilityLabel="Attach file"
                className="size-10 rounded-full px-0"
                variant="ghost"
                onPress={onAttach}
              >
                <Paperclip size={19} color={colors.text} />
              </Button>
              <Text className="ml-auto px-2 text-[9px] text-muted-foreground">
                {text.length.toLocaleString()} characters
              </Text>
            </View>
          </View>
        </Modal>
      )}
    </KeyboardAvoidingView>
  );
}

function ChatQueueStrip({
  messages,
  expanded = false,
}: {
  messages: readonly TerminalComposerQueueItem[];
  expanded?: boolean;
}) {
  if (!messages.length) return null;
  return (
    <View className={expanded ? 'border-b border-border px-3 py-3' : 'border-b border-border px-2.5 py-2'}>
      <Text className="mb-1.5 text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
        Outbox · {messages.length}
      </Text>
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-2"
      >
        {messages.map(message => (
          <View
            key={message.id}
            className="h-11 w-52 justify-center rounded-md border border-border bg-muted px-2.5"
          >
            <Text numberOfLines={1} className="text-[10px] text-foreground">
              {message.historyEntry}
            </Text>
            <Text className="text-[8px] text-muted-foreground">
              {message.sending ? 'Sending' : message.error ? 'Retrying' : 'Queued until connected'}
            </Text>
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
    <View
      className={
        expanded
          ? 'flex-row flex-wrap gap-2 border-b border-border px-3 py-3'
          : 'flex-row flex-wrap gap-1.5 border-b border-border px-2.5 py-2'
      }
    >
      {attachments.map(path => (
        <Pressable
          key={path}
          accessibilityLabel={`Remove ${path.split('/').pop()}`}
          className="flex-row items-center gap-1.5 rounded-md bg-muted px-2 py-1.5 active:opacity-70"
          onPress={() => onRemoveAttachment(path)}
        >
          <File size={12} color={colors.textSecondary} />
          <Text
            numberOfLines={1}
            className="max-w-[240px] font-mono text-[9px] text-muted-foreground"
          >
            {path.split('/').pop()}
          </Text>
          <X size={11} color={colors.textSecondary} />
        </Pressable>
      ))}
    </View>
  );
}
