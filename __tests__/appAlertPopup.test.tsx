import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import { AppAlertPopup } from '../src/components/AppAlertPopup';

jest.mock('lucide-react-native', () => ({ CircleAlert: 'CircleAlert' }));
jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  Modal: 'Modal',
  Pressable: 'Pressable',
  View: 'View',
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'common.close' ? 'Close' : key),
  }),
}));
jest.mock('../src/theme', () => ({
  useTheme: () => ({ colors: { error: '#CF222E' } }),
}));
jest.mock('../src/components/app-ui', () => ({
  hapticPress: (handler: () => void) => handler,
}));
jest.mock('../src/components/GlassSurface', () => ({
  GlassSurface: 'GlassSurface',
}));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));

function findHost(root: ReactTestInstance, type: string): ReactTestInstance {
  return root.find(node => node.type === type);
}

describe('AppAlertPopup', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  test('shows the original error in a centered glass popup and dismisses from its action', () => {
    const onClose = jest.fn();
    act(() => {
      renderer = create(
        <AppAlertPopup
          message="remote command exited with status 127"
          onClose={onClose}
          title="Herdr command failed"
          visible
        />,
      );
    });

    const modal = findHost(renderer.root, 'Modal');
    const glassSurface = findHost(renderer.root, 'GlassSurface');
    const text = renderer.root
      .findAll(node => (node.type as unknown) === 'Text')
      .flatMap(node => node.children);

    expect(modal.props).toEqual(
      expect.objectContaining({ transparent: true, visible: true }),
    );
    expect(glassSurface.props.className).toContain('max-w-[380px]');
    expect(glassSurface.props.className).toContain('rounded-[24px]');
    expect(glassSurface.props.className).toContain('dark:border-white/10');
    expect(text).toContain('Herdr command failed');
    expect(text).toContain('remote command exited with status 127');

    act(() => findHost(renderer.root, 'Button').props.onPress());
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => modal.props.onRequestClose());
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('Herdr alert migrations', () => {
  const screenNames = ['PaneDetail.tsx', 'HerdScreen.tsx', 'SessionScreen.tsx'];
  const screens = Object.fromEntries(
    screenNames.map(name => [
      name,
      readFileSync(join(__dirname, '..', 'src', 'components', name), 'utf8'),
    ]),
  );

  test.each(screenNames)(
    '%s uses AppAlertPopup without native Alert.alert calls',
    name => {
      expect(screens[name]).toContain('<AppAlertPopup');
      expect(screens[name]).not.toMatch(/\bAlert\.alert\s*\(/);
    },
  );

  test('Codex integration failures use the same app-styled alert', () => {
    expect(screens['SessionScreen.tsx']).toContain(
      "showAppAlert('Could not install Codex integration', error)",
    );
    expect(screens['SessionScreen.tsx']).toContain(
      "showAppAlert('Could not check Codex integration', error)",
    );
  });
});
