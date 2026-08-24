import { requireNativeViewManager } from 'expo-modules-core';
import type { ViewProps } from 'react-native';

interface NativeAgentSpinnerViewProps extends ViewProps {
  color: string;
  durationMs: number;
  enabled: boolean;
}

const NativeAgentSpinnerView = requireNativeViewManager<NativeAgentSpinnerViewProps>(
  'WhipNativeSpinner',
  'WhipAgentSpinnerView',
);

export function NativeAgentSpinner({
  color,
  durationMs,
  enabled,
  size,
}: {
  color: string;
  durationMs: number;
  enabled: boolean;
  size: number;
}) {
  return (
    <NativeAgentSpinnerView
      color={color}
      durationMs={durationMs}
      enabled={enabled}
      pointerEvents="none"
      style={{ width: size, height: size }}
    />
  );
}
