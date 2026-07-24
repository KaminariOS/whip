import type { HerdrClient } from '../services/HerdrClient';
import type { TerminalSession } from '../terminalSessions';
import type { PaneScrollInfo } from '../types';

export interface TerminalRenderTarget {
  key: string;
  hostSessionId: string;
  client: HerdrClient;
  session: TerminalSession;
  scroll?: PaneScrollInfo;
}

export function terminalRendererKey(hostSessionId: string, terminalId: string): string {
  return `${hostSessionId.length}:${hostSessionId}${terminalId}`;
}
