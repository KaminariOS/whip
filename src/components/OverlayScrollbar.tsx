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

import { useTheme } from '../theme';
import { useReducedMotion } from './app-ui';

export interface OverlayScrollbarDragEvent {
  dy: number;
  trackHeight: number;
  thumbHeight: number;
}

interface Props {
  heightPercent: number;
  topPercent: number;
  accessibilityLabel: string;
  onDragStart?: (event: Omit<OverlayScrollbarDragEvent, 'dy'>) => void;
  onDrag?: (event: OverlayScrollbarDragEvent) => void;
  onDragEnd?: () => void;
  onAccessibilityAdjust?: (direction: 'up' | 'down') => void;
}

const ACTIVE_OPACITY = 0.76;
const ACTIVE_WIDTH = 6;
const HIT_TARGET_WIDTH = 24;
const IDLE_OPACITY = 0.36;
const IDLE_WIDTH = 2;
const MIN_HIT_TARGET_HEIGHT = 28;
const RIGHT_INSET = 3;
const TRANSITION_MS = 120;

function boundedPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function OverlayScrollbar({
  heightPercent,
  topPercent,
  accessibilityLabel,
  onDragStart,
  onDrag,
  onDragEnd,
  onAccessibilityAdjust,
}: Props) {
  const { colors } = useTheme();
  const reduceMotion = useReducedMotion();
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
    active.value = withTiming(0, {
      duration: reduceMotionRef.current ? 0 : TRANSITION_MS,
    });
    callbacksRef.current.onDragEnd?.();
  };

  const panResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
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

  const animatedThumbStyle = useAnimatedStyle(() => ({
    opacity: IDLE_OPACITY + ((ACTIVE_OPACITY - IDLE_OPACITY) * active.value),
    width: IDLE_WIDTH + ((ACTIVE_WIDTH - IDLE_WIDTH) * active.value),
  }));

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

  return (
    <View
      pointerEvents="box-none"
      style={styles.track}
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
              {
                backgroundColor: colors.textSecondary,
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
