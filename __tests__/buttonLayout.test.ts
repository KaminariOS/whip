import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(__dirname, '..', 'src/components/ui/button.tsx'), 'utf8');

describe('button layout', () => {
  test('default buttons do not reserve vertical padding inside fixed heights', () => {
    expect(source).toContain("default: cn('h-10 px-4 py-0 sm:h-9'");
    expect(source).not.toContain("default: cn('h-10 px-4 py-2 sm:h-9'");
  });
});
