import { buttonVariants } from '../src/components/ui/button';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  Platform: { select: () => undefined },
  Pressable: 'Pressable',
}));
jest.mock(
  '@/src/components/ui/text',
  () => ({
    TextClassContext: jest.requireActual('react').createContext(undefined),
  }),
  { virtual: true },
);
jest.mock(
  '@/src/lib/utils',
  () => ({
    cn: (...values: Array<string | false | null | undefined>) =>
      values.filter(Boolean).join(' '),
  }),
  { virtual: true },
);

describe('button layout', () => {
  test('the default variant resolves to fixed height without vertical padding', () => {
    const classNames = buttonVariants().split(/\s+/);

    expect(classNames).toEqual(
      expect.arrayContaining(['h-10', 'px-4', 'py-0']),
    );
    expect(classNames).not.toContain('py-2');
  });
});
