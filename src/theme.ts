export const colors = {
  ink: '#090b0a',
  panel: '#121612',
  panelRaised: '#1a2019',
  line: '#30382c',
  text: '#e9eadf',
  muted: '#92998a',
  acid: '#d8ff63',
  working: '#78c6b3',
  blocked: '#ff876f',
  done: '#d8ff63',
  idle: '#899184',
  unknown: '#b696c1',
};

export function statusColor(status: string): string {
  return colors[status as keyof typeof colors] || colors.unknown;
}
