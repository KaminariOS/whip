const mockAuthenticateAsync = jest.fn();
const mockAuthenticateAppAccess = jest.fn();
const mockAuthenticateGlobalKeychain = jest.fn();
let mockPlatformOs = 'ios';

jest.mock('expo-local-authentication', () => ({
  authenticateAsync: (...args: unknown[]) => mockAuthenticateAsync(...args),
}));

jest.mock('react-native', () => ({
  NativeModules: {
    HerdrCredentialVault: {
      authenticateAppAccess: (...args: unknown[]) => mockAuthenticateAppAccess(...args),
      authenticateGlobalKeychain: (...args: unknown[]) => mockAuthenticateGlobalKeychain(...args),
    },
  },
  Platform: {
    get OS() {
      return mockPlatformOs;
    },
  },
}));

import {
  authenticateAppAccess,
  authenticateGlobalKeychain,
} from '../src/services/appAuthentication';

beforeEach(() => {
  mockPlatformOs = 'ios';
  jest.clearAllMocks();
});

it('uses the iOS system authentication sheet with device passcode fallback', async () => {
  mockAuthenticateAsync.mockResolvedValue({ success: true });

  await authenticateAppAccess();

  expect(mockAuthenticateAsync).toHaveBeenCalledWith({
    promptMessage: 'Unlock Whip',
    cancelLabel: 'Cancel',
    disableDeviceFallback: false,
    fallbackLabel: 'Use Device Passcode',
  });
  expect(mockAuthenticateAppAccess).not.toHaveBeenCalled();
});

it('uses a purpose-specific prompt for the global SSH keychain', async () => {
  mockAuthenticateAsync.mockResolvedValue({ success: true });

  await authenticateGlobalKeychain();

  expect(mockAuthenticateAsync).toHaveBeenCalledWith(expect.objectContaining({
    promptMessage: 'Unlock SSH keychain',
    disableDeviceFallback: false,
  }));
});

it('preserves cancellation codes used by the lock screen and keychain UI', async () => {
  mockAuthenticateAsync.mockResolvedValue({ success: false, error: 'user_cancel' });

  await expect(authenticateAppAccess()).rejects.toMatchObject({ code: 'E_APP_AUTH_CANCELLED' });
  await expect(authenticateGlobalKeychain()).rejects.toMatchObject({ code: 'E_GLOBAL_KEYCHAIN_CANCELLED' });
});

it('keeps Android on the existing native authentication implementation', async () => {
  mockPlatformOs = 'android';
  mockAuthenticateAppAccess.mockResolvedValue(true);
  mockAuthenticateGlobalKeychain.mockResolvedValue(true);

  await authenticateAppAccess();
  await authenticateGlobalKeychain();

  expect(mockAuthenticateAppAccess).toHaveBeenCalledTimes(1);
  expect(mockAuthenticateGlobalKeychain).toHaveBeenCalledTimes(1);
  expect(mockAuthenticateAsync).not.toHaveBeenCalled();
});
