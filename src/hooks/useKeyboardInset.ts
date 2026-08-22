import { useCallback, useEffect, useEffectEvent, useState, type RefObject } from 'react';
import { Keyboard, type View } from 'react-native';

interface KeyboardInsetOptions {
  enabled?: boolean;
  onVisibilityChange?: (visible: boolean) => void;
}

export function useKeyboardInset(
  measuredViewRef: RefObject<View | null>,
  { enabled = true, onVisibilityChange }: KeyboardInsetOptions = {},
) {
  const [inset, setInset] = useState(0);
  const reportVisibility = useEffectEvent((visible: boolean) => {
    onVisibilityChange?.(visible);
  });

  useEffect(() => {
    if (!enabled) {
      setInset(0);
      reportVisibility(false);
      return;
    }

    let insetTimer: ReturnType<typeof setTimeout> | null = null;
    const show = Keyboard.addListener('keyboardDidShow', event => {
      if (insetTimer) clearTimeout(insetTimer);
      setInset(0);
      reportVisibility(true);
      insetTimer = setTimeout(() => {
        const keyboardTop = event.endCoordinates.screenY;
        measuredViewRef.current?.measureInWindow((_x, y, _width, height) => {
          setInset(Math.max(0, Math.ceil(y + height - keyboardTop)));
        });
      }, 50);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      if (insetTimer) clearTimeout(insetTimer);
      insetTimer = null;
      setInset(0);
      reportVisibility(false);
    });
    return () => {
      if (insetTimer) clearTimeout(insetTimer);
      show.remove();
      hide.remove();
    };
  }, [enabled, measuredViewRef]);

  const resetInset = useCallback(() => setInset(0), []);
  return { inset, resetInset };
}
