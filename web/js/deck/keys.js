// Anything with travel. Pointer, touch, keyboard and assistive tech all arrive at the same three
// callbacks, and the deck moves the cap from the action, so a key pressed on the keyboard or the
// gamepad moves on screen too.

/**
 * @param {HTMLElement} element
 * @param {{down: () => void, up: () => void, cancel?: () => void, latch?: () => boolean,
 *   holding?: () => boolean, onLatch?: (on: boolean) => void}} handlers `latch` says this press
 *   starts a timed hold. A press with no pointer, such as a screen reader's, cannot be held, so
 *   then one activation starts the hold and the next one cancels it.
 * @returns {() => void} detach
 */
export function pressable(element, { down, up, cancel = up, latch, holding, onLatch }) {
  let active = null;

  const inside = (event) => {
    const box = element.getBoundingClientRect();
    return event.clientX >= box.left - 12 && event.clientX <= box.right + 12
      && event.clientY >= box.top - 12 && event.clientY <= box.bottom + 12;
  };

  function onPointerDown(event) {
    if (event.button > 0 || active !== null) return;
    event.preventDefault();
    active = event.pointerId;
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic pointer cannot be captured, and does not need to be.
    }
    down();
  }
  function onPointerUp(event) {
    if (event.pointerId !== active) return;
    active = null;
    if (inside(event)) up();
    else cancel();
  }
  function onPointerCancel(event) {
    if (event.pointerId !== active) return;
    active = null;
    cancel();
  }

  let keyHeld = false;
  function onKeyDown(event) {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat || keyHeld) return;
    keyHeld = true;
    down();
  }
  function onKeyUp(event) {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    if (!keyHeld) return;
    keyHeld = false;
    up();
  }
  function onBlur() {
    if (!keyHeld) return;
    keyHeld = false;
    cancel();
  }
  /** A screen reader presses with a click and nothing else. */
  function onClick(event) {
    if (event.detail !== 0 || active !== null || keyHeld) return;
    if (latch?.()) {
      const on = !holding?.();
      onLatch?.(on);
      if (on) down();
      else up();
      return;
    }
    down();
    up();
  }
  const quiet = (event) => event.preventDefault();

  const listeners = {
    pointerdown: onPointerDown, pointerup: onPointerUp, pointercancel: onPointerCancel,
    keydown: onKeyDown, keyup: onKeyUp, blur: onBlur, click: onClick, contextmenu: quiet,
    mousedown: quiet, // keeps the page's Space for Talk after a click
  };
  for (const [name, listener] of Object.entries(listeners)) element.addEventListener(name, listener);
  return () => {
    for (const [name, listener] of Object.entries(listeners)) element.removeEventListener(name, listener);
  };
}
