import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type NativeTouchEvent,
  View,
} from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import {
  clampImageTranslation,
  clampImageZoom,
  containedImageSize,
  DOUBLE_TAP_IMAGE_ZOOM,
  MIN_IMAGE_ZOOM,
  type ImageZoomSize,
} from '@/src/lib/imageZoom';
import { DEFAULT_SPRING_CONFIG } from '@/src/lib/motion';

interface Props {
  accessibilityLabel: string;
  uri: string;
}

interface ImageTransform {
  scale: number;
  x: number;
  y: number;
}

interface Point {
  x: number;
  y: number;
}

const emptySize: ImageZoomSize = { width: 0, height: 0 };

export function ZoomableImagePreview({ accessibilityLabel, uri }: Props) {
  const [viewport, setViewport] = useState<ImageZoomSize>(emptySize);
  const [sourceSize, setSourceSize] = useState<ImageZoomSize | null>(null);
  const viewportRef = useRef(viewport);
  const renderedSize = useMemo(
    () => containedImageSize(sourceSize || viewport, viewport),
    [sourceSize, viewport],
  );
  const renderedSizeRef = useRef(renderedSize);
  const scale = useSharedValue(MIN_IMAGE_ZOOM);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);

  useEffect(() => () => {
    cancelAnimation(scale);
    cancelAnimation(translateX);
    cancelAnimation(translateY);
  }, [scale, translateX, translateY]);
  const liveTransformRef = useRef<ImageTransform>({
    scale: MIN_IMAGE_ZOOM,
    x: 0,
    y: 0,
  });
  const gestureStartRef = useRef<ImageTransform>(liveTransformRef.current);
  const pinchStartDistanceRef = useRef(0);
  const pinchStartCentroidRef = useRef<Point>({ x: 0, y: 0 });
  const gestureModeRef = useRef<'tap' | 'pan' | 'pinch'>('tap');
  const lastTapRef = useRef<{ at: number; point: Point } | null>(null);

  viewportRef.current = viewport;
  renderedSizeRef.current = renderedSize;

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  const setTransform = (next: ImageTransform, animate = false) => {
    const zoom = clampImageZoom(next.scale);
    const size = renderedSizeRef.current;
    const bounds = viewportRef.current;
    const x =
      zoom === MIN_IMAGE_ZOOM
        ? 0
        : clampImageTranslation(next.x, size.width, bounds.width, zoom);
    const y =
      zoom === MIN_IMAGE_ZOOM
        ? 0
        : clampImageTranslation(next.y, size.height, bounds.height, zoom);
    liveTransformRef.current = { scale: zoom, x, y };
    scale.value = animate ? withSpring(zoom, DEFAULT_SPRING_CONFIG) : zoom;
    translateX.value = animate ? withSpring(x, DEFAULT_SPRING_CONFIG) : x;
    translateY.value = animate ? withSpring(y, DEFAULT_SPRING_CONFIG) : y;
  };

  const reset = (animate: boolean) => {
    setTransform({ scale: MIN_IMAGE_ZOOM, x: 0, y: 0 }, animate);
  };

  const beginPinch = (touches: readonly NativeTouchEvent[]) => {
    gestureModeRef.current = 'pinch';
    gestureStartRef.current = liveTransformRef.current;
    pinchStartDistanceRef.current = touchDistance(touches);
    pinchStartCentroidRef.current = touchCentroid(touches);
    lastTapRef.current = null;
  };

  const handleMove = (event: GestureResponderEvent, dx: number, dy: number) => {
    const touches = event.nativeEvent.touches;
    if (touches.length >= 2) {
      if (gestureModeRef.current !== 'pinch') beginPinch(touches);
      const start = gestureStartRef.current;
      const startDistance = pinchStartDistanceRef.current;
      if (startDistance <= 0) return;
      const nextScale = clampImageZoom(
        start.scale * (touchDistance(touches) / startDistance),
      );
      const startCentroid = pinchStartCentroidRef.current;
      const centroid = touchCentroid(touches);
      const viewportSize = viewportRef.current;
      const startFocusX = startCentroid.x - viewportSize.width / 2;
      const startFocusY = startCentroid.y - viewportSize.height / 2;
      const focusX = centroid.x - viewportSize.width / 2;
      const focusY = centroid.y - viewportSize.height / 2;
      const ratio = nextScale / start.scale;
      setTransform({
        scale: nextScale,
        x: focusX - (startFocusX - start.x) * ratio,
        y: focusY - (startFocusY - start.y) * ratio,
      });
      return;
    }

    if (gestureModeRef.current === 'pinch') return;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) gestureModeRef.current = 'pan';
    const start = gestureStartRef.current;
    if (start.scale > MIN_IMAGE_ZOOM) {
      setTransform({ scale: start.scale, x: start.x + dx, y: start.y + dy });
    }
  };

  const handleTap = (event: GestureResponderEvent) => {
    const now = Date.now();
    const point = {
      x: event.nativeEvent.locationX,
      y: event.nativeEvent.locationY,
    };
    const previous = lastTapRef.current;
    if (
      previous &&
      now - previous.at < 300 &&
      pointDistance(previous.point, point) < 32
    ) {
      lastTapRef.current = null;
      if (liveTransformRef.current.scale > MIN_IMAGE_ZOOM) reset(true);
      else setTransform({ scale: DOUBLE_TAP_IMAGE_ZOOM, x: 0, y: 0 }, true);
      return;
    }
    lastTapRef.current = { at: now, point };
  };

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: event => {
          cancelAnimation(scale);
          cancelAnimation(translateX);
          cancelAnimation(translateY);
          gestureModeRef.current = 'tap';
          gestureStartRef.current = liveTransformRef.current;
          const touches = event.nativeEvent.touches;
          if (touches.length >= 2) beginPinch(touches);
        },
        onPanResponderMove: (event, gesture) =>
          handleMove(event, gesture.dx, gesture.dy),
        onPanResponderRelease: (event, gesture) => {
          if (
            gestureModeRef.current === 'tap' &&
            Math.abs(gesture.dx) < 8 &&
            Math.abs(gesture.dy) < 8
          ) {
            handleTap(event);
          } else {
            setTransform(liveTransformRef.current, true);
          }
          pinchStartDistanceRef.current = 0;
        },
        onPanResponderTerminate: () => {
          setTransform(liveTransformRef.current, true);
          pinchStartDistanceRef.current = 0;
        },
        onPanResponderTerminationRequest: () => false,
      }),
    // Gesture handlers intentionally read mutable refs so this responder remains stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Ref-backed gesture handlers must retain responder identity.
    [],
  );

  useEffect(() => {
    setSourceSize(null);
    reset(false);
    // Reset the viewer whenever a different cached image is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- URI identity, rather than the stable reset callback, controls this reset.
  }, [uri]);

  useEffect(() => {
    setTransform(liveTransformRef.current, false);
    // Re-clamp the current transform after image load or an orientation change.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Geometry changes re-clamp the latest ref-backed transform.
  }, [
    renderedSize.height,
    renderedSize.width,
    viewport.height,
    viewport.width,
  ]);

  const handleLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setViewport({ width, height });
  };

  return (
    <View
      className="flex-1 items-center justify-center overflow-hidden"
      onLayout={handleLayout}
      {...panResponder.panHandlers}
    >
      {viewport.width > 0 && viewport.height > 0 ? (
        <Animated.Image
          accessibilityLabel={accessibilityLabel}
          onLoad={event => {
            const { width, height } = event.nativeEvent.source;
            if (width > 0 && height > 0) setSourceSize({ width, height });
          }}
          resizeMode="contain"
          source={{ uri }}
          style={[
            { width: renderedSize.width, height: renderedSize.height },
            animatedStyle,
          ]}
        />
      ) : null}
    </View>
  );
}

function touchDistance(touches: readonly NativeTouchEvent[]): number {
  if (touches.length < 2) return 0;
  return Math.hypot(
    touches[1].locationX - touches[0].locationX,
    touches[1].locationY - touches[0].locationY,
  );
}

function touchCentroid(touches: readonly NativeTouchEvent[]): Point {
  if (touches.length < 2) return { x: 0, y: 0 };
  return {
    x: (touches[0].locationX + touches[1].locationX) / 2,
    y: (touches[0].locationY + touches[1].locationY) / 2,
  };
}

function pointDistance(first: Point, second: Point): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}
