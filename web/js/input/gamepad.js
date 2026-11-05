// The gamepad layer of the deck (research 04, section 6.3). Reads the pad once a frame while one
// is connected and turns it into the same actions the keyboard makes. Nothing runs without a pad,
// and nothing runs while the page is hidden.
//
//   left stick or d-pad   the eight winds
//   right trigger         the dial: the furthest it was pulled is the detent, set on release
//   A / B                 Approve / Reject, down and up, so A can hold a ring
//   X                     Talk, held
//   Y                     Steer
//   bumpers               previous and next hull

const STICK_ON = 0.55;
const STICK_OFF = 0.4;
const TRIGGER_REST = 0.06;
const TRIGGER_STOPS = [0.34, 0.68];
const SECTORS = Object.freeze(['e', 'se', 's', 'sw', 'w', 'nw', 'n', 'ne']);

const B = Object.freeze({ a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, trigger: 7, up: 12, down: 13, left: 14, right: 15 });

/** The sector of a stick position, or null inside the dead zone. */
export function windOf(x, y, wasActive = false) {
  const reach = Math.hypot(x, y);
  if (reach < (wasActive ? STICK_OFF : STICK_ON)) return null;
  const sector = Math.round(Math.atan2(y, x) / (Math.PI / 4));
  return SECTORS[(sector + 8) % 8];
}

const pressed = (pad, index) => Boolean(pad.buttons[index]?.pressed);
const analog = (pad, index) => pad.buttons[index]?.value ?? 0;

function padWind(pad, wasActive) {
  const stick = windOf(pad.axes[0] ?? 0, pad.axes[1] ?? 0, wasActive);
  if (stick) return stick;
  const vertical = pressed(pad, B.up) ? 'n' : pressed(pad, B.down) ? 's' : '';
  const horizontal = pressed(pad, B.right) ? 'e' : pressed(pad, B.left) ? 'w' : '';
  return vertical + horizontal || null;
}

/** @param {{actions: {emit: (action: any) => void}}} store */
export function installGamepad(store) {
  if (typeof navigator.getGamepads !== 'function') return () => {};
  const emit = (action) => store.actions.emit(action);
  /** @type {Map<number, {buttons: boolean[], wind: string|null, peak: number, stop: number}>} */
  const memory = new Map();
  let frame = 0;

  function button(previous, index, pad, onDown, onUp) {
    const now = pressed(pad, index);
    if (now && !previous.buttons[index]) onDown();
    else if (!now && previous.buttons[index]) onUp?.();
    previous.buttons[index] = now;
  }

  function read(pad) {
    let previous = memory.get(pad.index);
    if (!previous) {
      previous = { buttons: [], wind: null, peak: 0, stop: -1 };
      memory.set(pad.index, previous);
    }
    button(previous, B.a, pad, () => emit({ type: 'approve', phase: 'down' }), () => emit({ type: 'approve', phase: 'up' }));
    button(previous, B.b, pad, () => emit({ type: 'reject', phase: 'down' }), () => emit({ type: 'reject', phase: 'up' }));
    button(previous, B.x, pad, () => emit({ type: 'talk', phase: 'down' }), () => emit({ type: 'talk', phase: 'up' }));
    button(previous, B.y, pad, () => emit({ type: 'steer' }));
    button(previous, B.lb, pad, () => emit({ type: 'hull', delta: -1 }));
    button(previous, B.rb, pad, () => emit({ type: 'hull', delta: 1 }));

    const wind = padWind(pad, previous.wind !== null);
    if (wind && wind !== previous.wind) emit({ type: 'wind', wind });
    previous.wind = wind;

    const pull = analog(pad, B.trigger);
    if (pull > TRIGGER_REST) {
      previous.peak = Math.max(previous.peak, pull);
      const stop = TRIGGER_STOPS.filter((edge) => previous.peak >= edge).length;
      if (stop !== previous.stop) {
        previous.stop = stop;
        emit({ type: 'dial', stop, phase: 'preview' });
      }
    } else if (previous.peak > 0) {
      emit({ type: 'dial', stop: previous.stop, phase: 'commit' });
      previous.peak = 0;
      previous.stop = -1;
    }
  }

  function poll() {
    frame = 0;
    if (document.hidden) return;
    const pads = [...navigator.getGamepads()].filter(Boolean);
    for (const pad of pads) read(pad);
    if (pads.length > 0) frame = requestAnimationFrame(poll);
  }
  const wake = () => {
    if (!frame) frame = requestAnimationFrame(poll);
  };

  /** A pad that goes away must not leave a held key down. */
  function forget(event) {
    const previous = memory.get(event.gamepad.index);
    memory.delete(event.gamepad.index);
    if (!previous) return;
    if (previous.buttons[B.a]) emit({ type: 'approve', phase: 'cancel' });
    if (previous.buttons[B.b]) emit({ type: 'reject', phase: 'cancel' });
    if (previous.buttons[B.x]) emit({ type: 'talk', phase: 'up' });
  }

  addEventListener('gamepadconnected', wake);
  addEventListener('gamepaddisconnected', forget);
  document.addEventListener('visibilitychange', wake);
  if ([...navigator.getGamepads()].some(Boolean)) wake();

  return () => {
    removeEventListener('gamepadconnected', wake);
    removeEventListener('gamepaddisconnected', forget);
    document.removeEventListener('visibilitychange', wake);
    cancelAnimationFrame(frame);
  };
}
