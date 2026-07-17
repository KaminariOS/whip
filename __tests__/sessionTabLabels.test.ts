import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('session tab labels', () => {
  it('leaves enough vertical space for Android font descenders', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/SessionScreen.tsx'),
      'utf8',
    );

    expect(screen).toContain(
      'h-[30px] max-w-[170px] rounded-full bg-[#212121] px-[11px] py-0',
    );
    expect(screen).toContain(
      'max-w-[122px] pb-0.5 text-[11px] font-semibold leading-[18px]',
    );
  });
});
