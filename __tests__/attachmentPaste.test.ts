import {
  attachmentUploadName,
  uniqueRemoteAttachmentName,
} from '../src/lib/attachmentPaste';

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

test('creates unique shell-safe remote names while retaining the extension', () => {
  expect(uniqueRemoteAttachmentName(
    '/tmp/Résumé screenshot (final) 🖼️.PNG',
    'attachment-1234',
  )).toBe('Resume-screenshot-final-attachment-1234.PNG');
  expect(uniqueRemoteAttachmentName(
    'C:\\cache\\notes with spaces.txt',
    'attachment-5678',
  )).toBe('notes-with-spaces-attachment-5678.txt');
});
