export const MIN_PROTOCOL: number;
export const MAX_PROTOCOL: number;
export const MAX_FRAME_BYTES: number;

export function encodeUtf8(value: string): Uint8Array;
export function hello(
  protocol: number,
  columns: number,
  rows: number,
  cellWidth: number,
  cellHeight: number,
  terminalAttachLaunchMode?: 1 | 2,
): ArrayBuffer;
export function input(text: string): ArrayBuffer;
export function resize(
  columns: number,
  rows: number,
  cellWidth: number,
  cellHeight: number,
): ArrayBuffer;
export function detach(): ArrayBuffer;
export function attach(terminalId: string, takeover: boolean): ArrayBuffer;
export function scroll(
  up: boolean,
  lines: number,
  column?: number,
  row?: number,
  modifiers?: number,
): ArrayBuffer;

export type HerdrMessage = {
  kind: string;
  sequence?: number;
  encoding?: number;
  error?: string;
  width?: number;
  height?: number;
  full?: boolean;
  bytes?: Uint8Array;
  text?: string;
  body?: string;
  notificationKind?: number;
  flag?: boolean;
  count?: number;
};

export function decode(
  buffer: ArrayBuffer | ArrayBufferView,
  protocol: number,
): HerdrMessage;
