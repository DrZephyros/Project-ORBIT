import type { DesktopChannel } from '../../shared/ipc.js';

/**
 * The preload bridge. Declared in a standalone ambiguous-namespace file so the
 * global augmentation applies everywhere without importing anything.
 */
declare global {
  interface Window {
    orbit: {
      invoke: DesktopChannel;
      subscribe: (channel: string, listener: (...args: unknown[]) => void) => () => void;
    };
  }
}
