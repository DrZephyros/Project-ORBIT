import { useCallback, useEffect, useRef, useState } from 'react';
import type { RemoteKeyName } from '@orbit/shared';

/**
 * The iPad's own keyboard, aimed at the window on the iPad.
 *
 * Reported: "if I use the onscreen keyboard on my iPad, it must be able to type
 * into that window." A transferred window is a real window on the laptop, so the
 * only way to type into it is to send the keystrokes there - the soft keyboard
 * has nothing local to type into.
 *
 * Why a hidden textarea rather than a contenteditable or a visible field:
 *
 *  * iOS only raises the on-screen keyboard for a form field that is focused by
 *    a user gesture, and only keeps it up while that field has focus.
 *  * The text must not accumulate. The field is emptied after every keystroke, so
 *    it can never become a local buffer that disagrees with the remote window.
 *  * It must not scroll the page when it is focused, hence the fixed position.
 *
 * Named keys are sent as keys; everything else is sent as text. Text goes as one
 * message per keystroke so a slow link cannot reorder characters inside a word.
 */
const NAMED_KEYS: Record<string, RemoteKeyName> = {
  Enter: 'Enter',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Escape: 'Escape',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  Delete: 'Delete',
};

interface Sendable {
  send: (message: { t: 'receiver.remote.key'; panelId: string; text?: string; key?: RemoteKeyName; at: number }) => unknown;
}

export function RemoteKeyboard({ panelId, link }: { panelId: string | null; link: Sendable }) {
  const field = useRef<HTMLTextAreaElement | null>(null);
  const [open, setOpen] = useState(false);

  /**
   * Keep the field focused for as long as the keyboard is wanted.
   *
   * iOS blurs it whenever a tap lands anywhere else - including a hand pinch on
   * the remote window, which is the normal thing to do between typing - and the
   * keyboard then slides away. Re-focusing from inside a touch handler is
   * allowed, so this listens for the blur rather than polling.
   */
  useEffect(() => {
    if (!open) return;
    const el = field.current;
    if (!el) return;
    el.focus({ preventScroll: true });
  }, [open, panelId]);

  useEffect(() => {
    if (!panelId && open) setOpen(false);
  }, [panelId, open]);

  const send = useCallback(
    (message: { text?: string; key?: RemoteKeyName }) => {
      if (!panelId) return;
      void link.send({ t: 'receiver.remote.key', panelId, ...message, at: Date.now() });
    },
    [link, panelId],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // A composing key (an IME, a predictive suggestion) is not a keystroke
      // yet; sending it would type half a word and then the whole one.
      if (event.nativeEvent.isComposing) return;
      const named = NAMED_KEYS[event.key];
      if (named) {
        event.preventDefault();
        send({ key: named });
        return;
      }
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        send({ text: event.key });
        return;
      }
      // Anything else (magnifier shortcuts, emoji pickers) is left to the field
      // and cleared by the input handler below.
    },
    [send],
  );

  const onInput = useCallback(
    (event: React.FormEvent<HTMLTextAreaElement>) => {
      const value = event.currentTarget.value;
      if (!value) return;
      // A word typed at once - autocorrect, dictation, or a fast keyboard - is
      // still text meant for the remote window.
      event.currentTarget.value = '';
      send({ text: value });
    },
    [send],
  );

  if (!panelId) return null;

  return (
    <>
      <button
        type="button"
        className={`remote-keyboard-toggle ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((value) => !value)}
        aria-pressed={open}
        aria-label={open ? 'Hide keyboard' : 'Show keyboard'}
      >
        {open ? 'Hide keyboard' : 'Keyboard'}
      </button>
      <textarea
        ref={field}
        className="remote-keyboard-field"
        // Hidden from sight but kept in the layout: `display: none` or
        // `visibility: hidden` fields cannot take focus on iOS, and a field that
        // cannot take focus cannot raise the keyboard.
        value=""
        onChange={onInput}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Losing focus is what closing the keyboard looks like, so follow the
          // system rather than fighting it.
          if (open) setOpen(false);
        }}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        aria-hidden={!open}
        tabIndex={open ? 0 : -1}
        rows={1}
      />
    </>
  );
}
