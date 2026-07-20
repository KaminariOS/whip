import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('session tab labels', () => {
  it('leaves enough vertical space for Android font descenders', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/SessionScreen.tsx'),
      'utf8',
    );

    expect(screen).toContain(
      'h-[30px] min-w-0 flex-shrink justify-start gap-2 rounded-none px-[11px] py-0 pr-1',
    );
    expect(screen).toContain(
      'max-w-[94px] pb-0.5 text-[11px] font-semibold leading-[18px]',
    );
  });

  it('renders an immediate close control on every tab', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/SessionScreen.tsx'),
      'utf8',
    );

    expect(screen).toContain('accessibilityLabel={`Close ${label} tab`}');
    expect(screen).toContain('onPress={hapticPress(() => closeTab(item))}');
  });
});
