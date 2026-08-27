import { useEffect, useRef, useState } from 'react';
import {
  PanResponder,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
} from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import type { VisualContentInsets } from '../lib/floatingChrome';
import { colorWithAlpha, useTheme } from '../theme';
import { useReducedMotion } from './app-ui';

export interface OverlayScrollbarDragEvent {
  dy: number;
  trackHeight: number;
  thumbHeight: number;
}

interface Props {
  glass?: boolean;
  heightPercent: number;
  insets?: VisualContentInsets;
  topPercent: number;
  accessibilityLabel: string;
  onDragStart?: (event: Omit<OverlayScrollbarDragEvent, 'dy'>) => void;
  onDrag?: (event: OverlayScrollbarDragEvent) => void;
  onDragEnd?: () => void;
  onAccessibilityAdjust?: (direction: 'up' | 'down') => void;
}

const ACTIVE_OPACITY = 0.82;
const ACTIVE_WIDTH = 22;
const GLASS_BACKGROUND_ALPHA = 'B8';
const GLASS_BORDER_ALPHA = '47';
const GLASS_OPACITY = 0.58;
const HIT_TARGET_WIDTH = 40;
const IDLE_OPACITY = 0.36;
const IDLE_WIDTH = 14;
const MIN_HIT_TARGET_HEIGHT = 44;
const RIGHT_INSET = 2;
const TRANSITION_MS = 120;

function boundedPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function OverlayScrollbar({
  glass = true,
  heightPercent,
  insets,
  topPercent,
  accessibilityLabel,
  onDragStart,
  onDrag,
  onDragEnd,
  onAccessibilityAdjust,
}: Props) {
  const { colors } = useTheme();
  const reduceMotion = useReducedMotion();
  const [interacting, setInteracting] = useState(false);
  const [trackHeight, setTrackHeight] = useState(0);
  const active = useSharedValue(0);
  const reduceMotionRef = useRef(reduceMotion);
  const trackHeightRef = useRef(0);
  const thumbHeightRef = useRef(0);
  const finishDragRef = useRef<() => void>(() => undefined);
  const callbacksRef = useRef({ onDragStart, onDrag, onDragEnd });
  reduceMotionRef.current = reduceMotion;
  callbacksRef.current = { onDragStart, onDrag, onDragEnd };

  finishDragRef.current = () => {
    setInteracting(false);
    active.value = withTiming(0, {
      duration: reduceMotionRef.current ? 0 : TRANSITION_MS,
    });
    callbacksRef.current.onDragEnd?.();
  };

  const panResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      setInteracting(true);
      active.value = withTiming(1, {
        duration: reduceMotionRef.current ? 0 : TRANSITION_MS,
      });
      callbacksRef.current.onDragStart?.({
        trackHeight: trackHeightRef.current,
        thumbHeight: thumbHeightRef.current,
      });
    },
    onPanResponderMove: (_event, gesture) => {
      callbacksRef.current.onDrag?.({
        dy: gesture.dy,
        trackHeight: trackHeightRef.current,
        thumbHeight: thumbHeightRef.current,
      });
    },
    onPanResponderRelease: () => finishDragRef.current(),
    onPanResponderTerminate: () => finishDragRef.current(),
    onPanResponderTerminationRequest: () => false,
  })).current;

  useEffect(() => () => cancelAnimation(active), [active]);

  const glassEnabled = glass && !interacting;
  const animatedThumbStyle = useAnimatedStyle(() => ({
    opacity: glassEnabled
      ? GLASS_OPACITY
      : IDLE_OPACITY + ((ACTIVE_OPACITY - IDLE_OPACITY) * active.value),
    width: IDLE_WIDTH + ((ACTIVE_WIDTH - IDLE_WIDTH) * active.value),
  }), [glassEnabled]);

  const boundedHeightPercent = boundedPercent(heightPercent);
  const boundedTopPercent = boundedPercent(topPercent);
  const thumbHeight = trackHeight * boundedHeightPercent / 100;
  const thumbTop = trackHeight * boundedTopPercent / 100;
  const hitHeight = Math.min(trackHeight, Math.max(MIN_HIT_TARGET_HEIGHT, thumbHeight));
  const hitTop = Math.max(0, Math.min(
    trackHeight - hitHeight,
    thumbTop - ((hitHeight - thumbHeight) / 2),
  ));
  thumbHeightRef.current = thumbHeight;
  const progress = 100 - boundedHeightPercent > 0
    ? Math.round((boundedTopPercent / (100 - boundedHeightPercent)) * 100)
    : 0;

  const handleLayout = (event: LayoutChangeEvent) => {
    const nextHeight = event.nativeEvent.layout.height;
    trackHeightRef.current = nextHeight;
    setTrackHeight(nextHeight);
  };
  const handleAccessibilityAction = (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === 'increment') onAccessibilityAdjust?.('down');
    if (event.nativeEvent.actionName === 'decrement') onAccessibilityAdjust?.('up');
  };
  const thumbMaterialStyle = glassEnabled ? {
    backgroundColor: colorWithAlpha(colors.surface, GLASS_BACKGROUND_ALPHA),
    borderColor: colorWithAlpha(colors.text, GLASS_BORDER_ALPHA),
    borderWidth: StyleSheet.hairlineWidth,
  } : {
    backgroundColor: colors.textSecondary,
    borderColor: 'transparent',
    borderWidth: 0,
  };

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.track,
        insets ? { bottom: insets.bottom, top: insets.top } : undefined,
      ]}
      onLayout={handleLayout}>
      {trackHeight > 0 && (
        <View
          accessible
          accessibilityActions={[
            { name: 'increment', label: 'Scroll down' },
            { name: 'decrement', label: 'Scroll up' },
          ]}
          accessibilityLabel={accessibilityLabel}
          accessibilityRole="adjustable"
          accessibilityValue={{ min: 0, max: 100, now: progress }}
          style={[styles.hitTarget, { height: hitHeight, top: hitTop }]}
          onAccessibilityAction={handleAccessibilityAction}
          {...panResponder.panHandlers}>
          <Animated.View
            pointerEvents="none"
            style={[
              styles.thumb,
              thumbMaterialStyle,
              {
                height: thumbHeight,
                top: thumbTop - hitTop,
              },
              animatedThumbStyle,
            ]}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    bottom: 0,
    position: 'absolute',
    right: RIGHT_INSET,
    top: 0,
    width: HIT_TARGET_WIDTH,
  },
  hitTarget: {
    alignItems: 'flex-end',
    position: 'absolute',
    right: 0,
    width: HIT_TARGET_WIDTH,
  },
  thumb: {
    borderRadius: ACTIVE_WIDTH / 2,
    position: 'absolute',
    right: 0,
  },
});
