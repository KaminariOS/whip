import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  File,
  FileDiff,
  Globe2,
  MessageSquareText,
  Paperclip,
  Send,
  Sparkles,
  SquareTerminal,
  X,
  Wrench,
} from 'lucide-react-native';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import type { AgentChatItem, AgentChatState } from '../agentChat';
import type { AgentStatus } from '../types';
import { statusColor, useTheme } from '../theme';
import { MarkdownText } from './MarkdownText';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Text } from './ui/text';

interface Props {
  state: AgentChatState;
  agentStatus: AgentStatus;
  attachments: readonly string[];
  sending: boolean;
  onOpenTerminal: () => void;
  onAttach: () => void;
  onRemoveAttachment: (path: string) => void;
  onSubmit: (text: string) => Promise<boolean>;
}

function ToolCard({
  item,
}: {
  item: Extract<AgentChatItem, { type: 'tool' }>;
}) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(item.status === 'failed');
  const Icon =
    item.toolKind === 'command'
      ? SquareTerminal
      : item.toolKind === 'file'
      ? FileDiff
      : item.toolKind === 'web'
      ? Globe2
      : Wrench;
  const hasDetail = Boolean(item.detail || item.output || item.diff);
  const stateColor =
    item.status === 'failed'
      ? colors.error
      : item.status === 'running'
      ? colors.primary
      : colors.done;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      disabled={!hasDetail}
      className="overflow-hidden rounded-xl border border-border bg-card"
      onPress={() => setExpanded(value => !value)}
    >
      <View className="flex-row items-center gap-2.5 px-3 py-2.5">
        <View className="size-7 items-center justify-center rounded-lg bg-muted">
          <Icon size={14} color={colors.textSecondary} />
        </View>
        <Text
          numberOfLines={expanded ? undefined : 1}
          className="min-w-0 flex-1 font-mono text-[11px] font-semibold leading-[17px] text-foreground"
        >
          {item.title}
        </Text>
        <View
          className="size-1.5 rounded-full"
          style={{ backgroundColor: stateColor }}
        />
        <Text className="text-[9px] font-bold text-muted-foreground">
          {item.status.toUpperCase()}
        </Text>
        {hasDetail &&
          (expanded ? (
            <ChevronDown size={15} color={colors.textSecondary} />
          ) : (
            <ChevronRight size={15} color={colors.textSecondary} />
          ))}
      </View>
      {expanded && hasDetail && (
        <View className="gap-3 border-t border-border bg-muted/40 px-3 py-3">
          {item.detail && (
            <Text
              selectable
              className="font-mono text-[10px] leading-[15px] text-muted-foreground"
            >
              {item.detail}
            </Text>
          )}
          {item.output && (
            <Text
              selectable
              className="font-mono text-[10px] leading-[15px] text-foreground"
            >
              {item.output}
            </Text>
          )}
          {item.diff && (
            <Text
              selectable
              className="font-mono text-[10px] leading-[15px] text-foreground"
            >
              {item.diff}
            </Text>
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
        <View className="max-w-[92%] rounded-2xl rounded-br-md bg-primary px-4 py-3">
          <Text
            selectable
            className="text-[14px] leading-[20px] text-primary-foreground"
          >
            {item.text}
          </Text>
        </View>
      </View>
    );
  }
  if (item.type === 'assistant-message') {
    return (
      <View className="flex-row items-start gap-2.5">
        <View className="mt-0.5 size-6 items-center justify-center rounded-full bg-primary/10">
          <Sparkles size={12} color={colors.primary} />
        </View>
        <View className="min-w-0 flex-1">
          <MarkdownText
            content={item.text}
            onLinkPress={({ url }) => {
              if (/^(?:https?:|mailto:|tel:)/i.test(url))
                Linking.openURL(url).catch(() => undefined);
            }}
          />
        </View>
      </View>
    );
  }
  if (item.type === 'tool') return <ToolCard item={item} />;
  if (item.type === 'plan') {
    return (
      <View className="border-l-2 border-primary bg-muted/30 py-1.5 pl-3 pr-2">
        <Text className="mb-2 text-[10px] font-bold uppercase tracking-[1px] text-muted-foreground">
          Plan
        </Text>
        <MarkdownText content={item.text} />
      </View>
    );
  }
  if (item.type === 'reasoning-summary') {
    return (
      <View className="flex-row gap-2 px-1 py-1">
        <Sparkles size={14} color={colors.textSecondary} />
        <Text
          selectable
          className="min-w-0 flex-1 text-[12px] italic leading-[18px] text-muted-foreground"
        >
          {item.text}
        </Text>
      </View>
    );
  }
  return (
    <View className="flex-row gap-2 border-l-2 border-border py-1.5 pl-3 pr-2">
      <CircleAlert size={15} color={colors.textSecondary} />
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
  agentStatus,
  attachments,
  sending,
  onOpenTerminal,
  onAttach,
  onRemoveAttachment,
  onSubmit,
}: Props) {
  const { colors } = useTheme();
  const [text, setText] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const list = useRef<FlatList<AgentChatItem>>(null);
  const previousCount = useRef(0);
  const agentColor = statusColor(agentStatus, colors);

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
    if (sending || (!text.trim() && !attachments.length)) return;
    if (await onSubmit(text)) setText('');
  };

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-background"
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View className="h-12 flex-row items-center gap-2 border-b border-border px-2">
        <Button
          accessibilityLabel="Open Terminal"
          className="h-9 flex-row gap-1 rounded-full px-2"
          variant="ghost"
          onPress={onOpenTerminal}
        >
          <ChevronLeft size={16} color={colors.textSecondary} />
          <SquareTerminal size={16} color={colors.text} />
        </Button>
        <View className="min-w-0 flex-1">
          <Text className="text-[13px] font-bold leading-[17px] text-foreground">
            Codex conversation
          </Text>
          <View className="flex-row items-center gap-1.5">
            <View
              className="size-1.5 rounded-full"
              style={{ backgroundColor: agentColor }}
            />
            <Text className="font-mono text-[8px] text-muted-foreground">
              {agentStatus.toUpperCase()} · {state.status.toUpperCase()}
            </Text>
          </View>
        </View>
        <View className="mr-2 size-8 items-center justify-center rounded-full bg-primary/10">
          <MessageSquareText size={16} color={colors.primary} />
        </View>
      </View>
      {state.status !== 'live' && (
        <View className="flex-row items-center gap-2 border-b border-border bg-muted/30 px-4 py-2">
          {state.status === 'loading' ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <CircleAlert size={14} color={colors.textSecondary} />
          )}
          <Text
            numberOfLines={2}
            className="min-w-0 flex-1 text-[10px] text-muted-foreground"
          >
            {state.error ||
              (state.status === 'loading'
                ? 'Reading the remote Codex rollout…'
                : 'The transcript is temporarily unavailable.')}
          </Text>
        </View>
      )}
      <View className="relative flex-1">
        <FlatList
          ref={list}
          data={state.items as AgentChatItem[]}
          keyExtractor={item => item.id}
          renderItem={({ item }) => <ChatItem item={item} />}
          contentContainerClassName="flex-grow gap-4 px-4 py-5"
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            state.status === 'live' ? (
              <View className="flex-1 items-center justify-center px-8 py-20">
                <View className="mb-4 size-11 items-center justify-center rounded-full bg-primary/10">
                  <MessageSquareText size={20} color={colors.primary} />
                </View>
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
            className="absolute bottom-3 right-4 h-9 flex-row gap-1.5 rounded-full px-3 shadow-lg"
            variant="secondary"
            onPress={() => list.current?.scrollToEnd({ animated: true })}
          >
            <ChevronDown size={15} color={colors.text} />
            <Text className="text-[10px] font-semibold">Latest</Text>
          </Button>
        )}
      </View>
      <View className="border-t border-border bg-background px-3 pb-2 pt-2.5">
        {attachments.length > 0 && (
          <View className="mb-2 flex-row flex-wrap gap-1.5">
            {attachments.map(path => (
              <Pressable
                key={path}
                accessibilityLabel={`Remove ${path.split('/').pop()}`}
                className="flex-row items-center gap-1.5 rounded-full bg-muted px-2.5 py-1.5 active:opacity-70"
                onPress={() => onRemoveAttachment(path)}
              >
                <File size={12} color={colors.textSecondary} />
                <Text
                  numberOfLines={1}
                  className="max-w-[190px] font-mono text-[9px] text-muted-foreground"
                >
                  {path.split('/').pop()}
                </Text>
                <X size={11} color={colors.textSecondary} />
              </Pressable>
            ))}
          </View>
        )}
        <View className="flex-row items-end gap-1 rounded-[22px] border border-border bg-card p-1.5">
          <Button
            accessibilityLabel="Attach file"
            className="size-9 rounded-full px-0"
            variant="ghost"
            onPress={onAttach}
          >
            <Paperclip size={17} color={colors.textSecondary} />
          </Button>
          <Input
            value={text}
            onChangeText={setText}
            multiline
            placeholder="Message Codex…"
            placeholderTextColor={colors.textTertiary}
            className="max-h-32 min-h-9 min-w-0 flex-1 border-0 bg-transparent px-2 py-2 text-[13px] shadow-none dark:bg-transparent"
          />
          <Button
            accessibilityLabel="Send message"
            className="size-9 rounded-full px-0"
            disabled={sending || (!text.trim() && !attachments.length)}
            onPress={submit}
          >
            {sending ? (
              <ActivityIndicator size="small" color={colors.onPrimary} />
            ) : (
              <Send size={16} color={colors.onPrimary} />
            )}
          </Button>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
