import { createManagedBackgroundImageStore } from './managedBackgroundImage';

const appBackgrounds = createManagedBackgroundImageStore(
  'app-backgrounds',
  'herdr-app-background-',
);

export const selectAppBackgroundImage = appBackgrounds.select;
export const migrateAppBackgroundImage = appBackgrounds.migrate;
export const removeAppBackgroundImage = appBackgrounds.remove;
