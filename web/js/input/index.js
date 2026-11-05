// The input layer. `a11y.js` already turns SPEC 12's keys into actions on key down, so this adds
// what a hold needs: the matching key up for Y and N, a cancel when focus leaves, and the gamepad.
// Surfaces only listen to `store.actions`, so every device takes the same path.
//
// Actions added here, on top of the table in web/README.md:
//   {type:'approve'|'reject', phase:'down'|'up'|'cancel'}   a11y sends no phase, which means down
//   {type:'dial', stop:0..2, phase:'preview'|'commit'}      the analog trigger
//   {type:'hull', delta:-1|1}                               step through the lamps

import { installGamepad } from '/js/input/gamepad.js';
import { perStore } from '/js/input/util.js';

const isTyping = (target) => Boolean(target?.closest?.('input,textarea,select,[contenteditable],[role=textbox]'));

function installHolds(store) {
  const held = new Set();
  const actionFor = { y: 'approve', n: 'reject' };

  function down(event) {
    if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
    const key = event.key.toLowerCase();
    if (actionFor[key] && !event.repeat) held.add(key);
  }
  function up(event) {
    const key = event.key.toLowerCase();
    if (held.delete(key)) store.actions.emit({ type: actionFor[key], phase: 'up' });
  }
  function drop() {
    for (const key of held) store.actions.emit({ type: actionFor[key], phase: 'cancel' });
    held.clear();
  }
  addEventListener('keydown', down, true);
  addEventListener('keyup', up);
  addEventListener('blur', drop);
  document.addEventListener('visibilitychange', drop);
  return () => {
    removeEventListener('keydown', down, true);
    removeEventListener('keyup', up);
    removeEventListener('blur', drop);
    document.removeEventListener('visibilitychange', drop);
  };
}

export const installInput = perStore((store) => {
  const offHolds = installHolds(store);
  const offPad = installGamepad(store);
  return () => {
    offHolds();
    offPad();
  };
});
