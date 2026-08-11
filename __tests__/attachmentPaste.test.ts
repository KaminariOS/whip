import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { attachmentUploadName } from '../src/lib/attachmentPaste';

test('creates timestamped shell-safe attachment names', () => {
  expect(attachmentUploadName(
    'Screen shot (final).PNG',
    'image/png',
    new Date('2026-07-22T14:25:30.000Z'),
  )).toBe('20260722-142530-Screen-shot-final.PNG');
  expect(attachmentUploadName(null, 'application/pdf', new Date('2026-07-22T14:25:30.000Z')))
    .toBe('20260722-142530-attachment.pdf');
});

test('uploads attachments through SFTP and pastes the remote path into the active terminal', () => {
  const client = readFileSync(resolve(__dirname, '../src/services/HerdrClient.ts'), 'utf8');
  const session = readFileSync(resolve(__dirname, '../src/components/SessionScreen.tsx'), 'utf8');
  const terminal = readFileSync(resolve(__dirname, '../src/components/TerminalScreen.tsx'), 'utf8');

  expect(client).toContain("const uploadDirectory = `${appDirectory}/uploads`");
  expect(client).toContain('await client.sftpUpload(localFilePath, uploadDirectory)');
  expect(session).toContain('<AttachmentPasteSheet');
  expect(session).toContain('terminalId: attachmentTerminalId');
  expect(terminal).toContain('renderer.current?.paste(pasteRequest.text)');
  expect(terminal).toContain('setComposeText(current =>');
});

test('shows uploaded images as removable composer thumbnails', () => {
  const terminal = readFileSync(resolve(__dirname, '../src/components/TerminalScreen.tsx'), 'utf8');

  expect(terminal).toContain("accessibilityLabel={t('terminal.attach')}");
  expect(terminal).toContain('<Paperclip size={18}');
  expect(terminal).toContain('attachments.map');
  expect(terminal).toContain('source={{ uri: attachment.previewUri }}');
  expect(terminal).toContain('onRemove={removeComposeAttachment}');
  expect(terminal).toContain('...attachmentPaths');
});

test('registers Android clipboard attachments and requests camera access', () => {
  const nativePackage = readFileSync(resolve(
    __dirname,
    '../android/app/src/main/java/io/github/kaminarios/whip/HerdrBackgroundPackage.kt',
  ), 'utf8');
  const manifest = readFileSync(resolve(__dirname, '../android/app/src/main/AndroidManifest.xml'), 'utf8');

  expect(nativePackage).toContain('ClipboardAttachmentModule(reactContext)');
  expect(nativePackage).toContain('ImageLibraryPickerModule(reactContext)');
  expect(manifest).toContain('android.permission.CAMERA');
  expect(manifest).not.toContain('tools:node="remove"');
});

test('uses the lifecycle-safe native Android picker for library images', () => {
  const picker = readFileSync(resolve(
    __dirname,
    '../android/app/src/main/java/io/github/kaminarios/whip/ImageLibraryPickerModule.kt',
  ), 'utf8');
  const attachmentService = readFileSync(resolve(
    __dirname,
    '../src/services/attachmentPaste.ts',
  ), 'utf8');

  expect(picker).toContain('ActivityEventListener');
  expect(picker).toContain('MediaStore.ACTION_PICK_IMAGES');
  expect(picker).toContain('Intent.ACTION_OPEN_DOCUMENT');
  expect(picker).toContain('type = "image/*"');
  expect(attachmentService).toContain('await pickImageFromLibrary()');
});
