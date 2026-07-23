let nextUuid = 0;

module.exports = {
  randomUUID: jest.fn(() => {
    nextUuid += 1;
    return `00000000-0000-4000-8000-${nextUuid.toString().padStart(12, '0')}`;
  }),
};
