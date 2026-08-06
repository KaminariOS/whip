import { createManagedBackgroundImageStore } from './managedBackgroundImage';

const terminalBackgrounds = createManagedBackgroundImageStore(
  'terminal-backgrounds',
  'herdr-terminal-background-',
);

export const selectTerminalBackgroundImage = terminalBackgrounds.select;
export const migrateTerminalBackgroundImage = terminalBackgrounds.migrate;
export const removeTerminalBackgroundImage = terminalBackgrounds.remove;
