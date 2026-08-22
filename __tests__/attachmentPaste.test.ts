import { attachmentUploadName } from '../src/lib/attachmentPaste';

test('creates timestamped shell-safe attachment names', () => {
  expect(
    attachmentUploadName(
      'Screen shot (final).PNG',
      'image/png',
      new Date('2026-07-22T14:25:30.000Z'),
    ),
  ).toBe('20260722-142530-Screen-shot-final.PNG');
  expect(
    attachmentUploadName(
      null,
      'application/pdf',
      new Date('2026-07-22T14:25:30.000Z'),
    ),
  ).toBe('20260722-142530-attachment.pdf');
});
