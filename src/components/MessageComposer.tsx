import { useRef, type ReactNode, type Ref } from 'react';
import { Maximize2, Paperclip, Send, X } from 'lucide-react-native';
import {
  ActivityIndicator,
  View,
  type ColorValue,
  type TextInput as TextInputHandle,
} from 'react-native';

import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Input } from './ui/input';

type ComposerInputProps = Omit<React.ComponentProps<typeof Input>, 'defaultValue' | 'value'> & {
  initialValue: string;
};

/**
 * Keeps Android's native text value uncontrolled while an IME composition is
 * active. Terminal and agent chat must share this behavior so partial IME
 * results are never replaced by a React render.
 */
export function ComposerInput({ initialValue, ...props }: ComposerInputProps) {
  const nativeInitialValue = useRef(initialValue).current;
  return <Input {...props} defaultValue={nativeInitialValue} />;
}

interface MessageComposerProps extends ComposerInputProps {
  actions: {
    actionClassName?: string;
    actionColor: ColorValue;
    attachLabel: string;
    closeLabel: string;
    expandLabel: string;
    onAttach: () => void;
    onClose: () => void;
    onExpand: () => void;
    onSend: () => void;
    sendLabel: string;
    sendClassName?: string;
    sendColor: ColorValue;
    sendDisabled?: boolean;
    sending?: boolean;
  };
  beforeInput?: ReactNode;
  className?: string;
  inputClassName?: string;
  inputRef?: Ref<TextInputHandle>;
  surfaceClassName?: string;
}

/** Shared composer layout used by terminal and native agent chat. */
export function MessageComposer({
  actions,
  beforeInput,
  className,
  inputClassName,
  inputRef,
  surfaceClassName,
  ...inputProps
}: MessageComposerProps) {
  return (
    <View className={cn('min-w-0 flex-row items-end gap-2', className)}>
      <View className="gap-1.5">
        <Button
          accessibilityLabel={actions.attachLabel}
          className={cn('size-10 rounded-full px-0', actions.actionClassName)}
          variant="secondary"
          onPress={actions.onAttach}
        >
          <Paperclip size={18} color={actions.actionColor} />
        </Button>
        <Button
          accessibilityLabel={actions.expandLabel}
          className={cn('size-10 rounded-full px-0', actions.actionClassName)}
          variant="secondary"
          onPress={actions.onExpand}
        >
          <Maximize2 size={17} color={actions.actionColor} />
        </Button>
      </View>
      <View
        className={cn(
          'min-w-0 flex-1 overflow-hidden rounded-[38px] border border-border bg-card',
          surfaceClassName,
        )}
      >
        {beforeInput}
        <ComposerInput
          {...inputProps}
          ref={inputRef}
          className={cn('rounded-none border-0 bg-transparent shadow-none', inputClassName)}
        />
      </View>
      <View className="gap-1.5">
        <Button
          accessibilityLabel={actions.sendLabel}
          className={cn('size-10 rounded-full px-0', actions.sendClassName)}
          disabled={actions.sendDisabled}
          onPress={actions.onSend}
        >
          {actions.sending ? (
            <ActivityIndicator size="small" color={actions.sendColor} />
          ) : (
            <Send size={17} color={actions.sendColor} />
          )}
        </Button>
        <Button
          accessibilityLabel={actions.closeLabel}
          className={cn('size-10 rounded-full px-0', actions.actionClassName)}
          variant="secondary"
          onPress={actions.onClose}
        >
          <X size={17} color={actions.actionColor} />
        </Button>
      </View>
    </View>
  );
}
