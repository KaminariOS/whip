import { ScrollView } from 'react-native';

import { useRemoteScrollProgress } from '@/src/hooks/useRemoteScrollProgress';
import type { RemoteContentIdentity } from '@/src/services/remoteContentProgress';
import { Text } from './ui/text';

interface Props {
  content: string;
  initialLine?: number;
  progressIdentity: RemoteContentIdentity;
}

export function RemoteTextPreview({ content, initialLine, progressIdentity }: Props) {
  const scrollProgress = useRemoteScrollProgress(
    progressIdentity,
    initialLine ? { y: 16 + Math.max(0, initialLine - 1) * 17 } : undefined,
  );
  return (
    <ScrollView
      {...scrollProgress}
      className="flex-1 bg-terminal-canvas"
      contentContainerClassName="p-4"
    >
      <ScrollView horizontal>
        <Text selectable className="font-mono text-[11px] leading-[17px] text-terminal-text">
          {content || ' '}
        </Text>
      </ScrollView>
    </ScrollView>
  );
}
