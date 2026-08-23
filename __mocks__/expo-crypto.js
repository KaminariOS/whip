let nextUuid = 0;
const { createHash } = require('crypto');

module.exports = {
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digest: jest.fn(async (algorithm, data) => {
    const name = algorithm.toLowerCase().replace('-', '');
    return Uint8Array.from(createHash(name).update(new Uint8Array(data)).digest()).buffer;
  }),
  randomUUID: jest.fn(() => {
    nextUuid += 1;
    return `00000000-0000-4000-8000-${nextUuid.toString().padStart(12, '0')}`;
  }),
};
