import { en } from '../src/locales/en';
import { zhHant } from '../src/locales/zh-Hant';

describe('localization resources', () => {
  it('keeps Traditional Chinese in sync with the English source catalog', () => {
    expect(Object.keys(zhHant).sort()).toEqual(Object.keys(en).sort());
  });

  it('includes translated primary navigation and settings labels', () => {
    expect(zhHant['nav.hosts']).toBe('主機');
    expect(zhHant['nav.terminal']).toBe('終端機');
    expect(zhHant['settings.keepScreenOn']).toBe('保持螢幕開啟');
    expect(zhHant['settings.language']).toBe('語言');
    expect(zhHant['connection.addPrivateKey']).toBe('新增私密金鑰');
  });

  it('describes hosts as general SSH destinations', () => {
    expect(en['hosts.emptyCopy']).toBe('Add an SSH destination to manage its Herdr session.');
    expect(en['connection.displayName']).toBe('Display name (optional)');
    expect(en['connection.hostOrIp']).toBe('SSH host or IP');
    expect(zhHant['connection.displayName']).toBe('顯示名稱（選填）');
    expect(en['app.connectUnreachableError']).not.toMatch(/tailscale/i);
    expect(zhHant['hosts.emptyCopy']).not.toMatch(/tailscale/i);
  });
});
