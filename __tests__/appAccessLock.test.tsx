import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import { AppAccessLock } from '../src/components/AppAccessLock';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  Modal: 'Modal',
  View: 'View',
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'app.biometricLocked': 'Whip is locked',
      'app.biometricLockedCopy': 'Authenticate to continue',
      'app.biometricRetry': 'Try again',
    })[key] || key,
  }),
}));
jest.mock('../src/components/app-ui', () => ({ WhipMark: 'WhipMark' }));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));

function findHost(root: ReactTestInstance, type: string): ReactTestInstance {
  return root.find(node => node.type === type);
}

describe('AppAccessLock', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  test('blocks the app and wires both retry entry points to authentication', () => {
    const onRetry = jest.fn();
    act(() => {
      renderer = create(<AppAccessLock authenticating={false} visible onRetry={onRetry} />);
    });

    const modal = findHost(renderer.root, 'Modal');
    expect(modal.props.visible).toBe(true);
    expect(findHost(renderer.root, 'WhipMark').props.accessibilityLabel).toBe('Whip is locked');

    act(() => findHost(renderer.root, 'Button').props.onPress());
    act(() => modal.props.onRequestClose());
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  test('hides retry while an authentication request is pending', () => {
    act(() => {
      renderer = create(<AppAccessLock authenticating visible onRetry={jest.fn()} />);
    });

    expect(renderer.root.findAll(node => (node.type as unknown) === 'Button')).toHaveLength(0);
  });
});
