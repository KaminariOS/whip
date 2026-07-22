import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('host list layout', () => {
  it('lets host content determine row height at large font scales', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/HostsScreen.tsx'),
      'utf8',
    );
    const button = readFileSync(
      resolve(__dirname, '../src/components/ui/button.tsx'),
      'utf8',
    );

    expect(button).toContain("content: ''");
    expect(screen).toContain('size="content"');
    expect(screen).toContain('h-auto min-h-[88px] min-w-0 flex-1 self-stretch');
    expect(screen).toContain('sm:h-auto');
  });

  it('places vertical space between host rows', () => {
    const screen = readFileSync(
      resolve(__dirname, '../src/components/HostsScreen.tsx'),
      'utf8',
    );

    expect(screen).toContain('<View className="gap-3">');
    expect(screen).toContain('rounded-lg border border-border bg-card pr-2');
  });
});
