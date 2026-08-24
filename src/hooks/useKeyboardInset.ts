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

    const show = Keyboard.addListener('keyboardDidShow', event => {
      reportVisibility(true);
      const keyboardTop = event.endCoordinates.screenY;
      measuredViewRef.current?.measureInWindow((_x, y, _width, height) => {
        setInset(Math.max(0, Math.ceil(y + height - keyboardTop)));
      });
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      setInset(0);
      reportVisibility(false);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [enabled, measuredViewRef]);

  const resetInset = useCallback(() => setInset(0), []);
  return { inset, resetInset };
}
