import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import { HostSessionRecoveryScreen } from '../src/components/HostSessionRecoveryScreen';

jest.mock('lucide-react-native', () => ({
  RefreshCw: 'RefreshCw',
  ServerOff: 'ServerOff',
}));
jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({ View: 'View' }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { host?: string }) =>
      values?.host ? `${key}:${values.host}` : key,
  }),
}));
jest.mock('../src/components/app-ui', () => ({
  hapticPress: (handler: () => void) => handler,
}));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/icon', () => ({ Icon: 'Icon' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));

function hostNodes(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => node.type === type);
}

describe('HostSessionRecoveryScreen', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  test('shows the failed host and exposes back and reconnect actions', () => {
    const onBack = jest.fn();
    const onReconnect = jest.fn();
    act(() => {
      renderer = create(
        <HostSessionRecoveryScreen
          busy={false}
          error="connection refused"
          host="localhost"
          onBack={onBack}
          onReconnect={onReconnect}
        />,
      );
    });

    const text = hostNodes(renderer.root, 'Text').flatMap(
      node => node.children,
    );
    const buttons = hostNodes(renderer.root, 'Button');
    expect(text).toEqual(
      expect.arrayContaining([
        'session.runtimeUnavailableTitle:localhost',
        'session.runtimeUnavailableCopy',
        'connection refused',
        'session.backToHerd',
        'session.reconnect',
      ]),
    );

    act(() => buttons[0].props.onPress());
    act(() => buttons[1].props.onPress());
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  test('disables duplicate retries while a full connection is running', () => {
    act(() => {
      renderer = create(
        <HostSessionRecoveryScreen
          busy
          host="localhost"
          onBack={jest.fn()}
          onReconnect={jest.fn()}
        />,
      );
    });

    const buttons = hostNodes(renderer.root, 'Button');
    const text = hostNodes(renderer.root, 'Text').flatMap(
      node => node.children,
    );
    expect(buttons[1].props.disabled).toBe(true);
    expect(text).toContain('session.reconnecting');
  });
});

describe('missing host runtime recovery wiring', () => {
  const runtimeManager = readFileSync(
    join(__dirname, '..', 'src/hooks/useSessionRuntimeManager.ts'),
    'utf8',
  );
  const appShell = readFileSync(
    join(__dirname, '..', 'src/components/AppShell.tsx'),
    'utf8',
  );

  test('rebuilds a missing runtime instead of trying to refresh it', () => {
    expect(runtimeManager).toContain("action === 'select'");
    expect(runtimeManager).toContain(
      'reuseConnectingSession: Boolean(existing)',
    );
  });

  test('renders recovery UI whenever terminal mode has a session without a runtime', () => {
    expect(appShell).toContain('activeSession &&');
    expect(appShell).toContain('!sessions.activeClient &&');
    expect(appShell).toContain('<HostSessionRecoveryScreen');
  });
});
