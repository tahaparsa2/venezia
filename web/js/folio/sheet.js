// The phone sheet. It rises above the deck, and a swipe down puts it away: from the handle or
// the head at any time, or from the page once that is scrolled to the top. While a finger is
// on it the slot follows by inline transform, and base.css takes back over on release.

import { reducedMotion } from '/js/folio/dom.js';

const DISMISS_PX = 96;
const FLICK_SPEED = 0.55;
const SLOP = 8;

const NO_DRAG = 'input,textarea,select,iframe,.scrub,.preview-stage,.seg,.tabs';

function scrollerOf(target, root) {
  for (let node = target; node && node !== root; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

/**
 * @param {HTMLElement} slot the moving sheet
 * @param {HTMLElement} page where touches are read
 * @param {{isSheet: () => boolean, dismiss: () => void}} options
 */
export function installSheet(slot, page, { isSheet, dismiss }) {
  let drag = null;

  const release = (dy, speed) => {
    const gone = dy > DISMISS_PX || speed > FLICK_SPEED;
    slot.style.transition = '';
    if (gone) {
      // Let go from where the finger left it: the stylesheet animates the rest.
      slot.style.transform = '';
      dismiss();
    } else {
      slot.style.transform = '';
    }
  };

  const move = (dy) => {
    slot.style.transition = 'none';
    slot.style.transform = `translateY(${Math.max(0, dy)}px)`;
  };

  function onTouchStart(event) {
    if (!isSheet() || event.touches.length !== 1) return;
    const { target } = event;
    if (target.closest(NO_DRAG)) return;
    const onHead = Boolean(target.closest('.grab,.folio-head'));
    drag = {
      y: event.touches[0].clientY, t: event.timeStamp, onHead, scroller: onHead ? null : scrollerOf(target, page), active: false, dy: 0,
    };
  }

  function onTouchMove(event) {
    if (!drag) return;
    const dy = event.touches[0].clientY - drag.y;
    if (!drag.active) {
      if (dy < -SLOP || (drag.scroller && drag.scroller.scrollTop > 0)) {
        drag = null;
        return;
      }
      if (dy < SLOP) return;
      drag.active = true;
      drag.y = event.touches[0].clientY;
      drag.t = event.timeStamp;
    }
    event.preventDefault();
    drag.dy = event.touches[0].clientY - drag.y;
    move(drag.dy);
  }

  function onTouchEnd(event) {
    if (!drag) return;
    const { active, dy, t } = drag;
    drag = null;
    if (active) release(dy, dy / Math.max(1, event.timeStamp - t));
  }

  /* A mouse on a narrow window gets the handle, so it behaves the same in a desktop browser. */
  function onPointerDown(event) {
    if (event.pointerType === 'touch' || !isSheet() || !event.target.closest('.grab')) return;
    const start = event.clientY;
    const began = event.timeStamp;
    const follow = (next) => move(next.clientY - start);
    const up = (next) => {
      removeEventListener('pointermove', follow);
      removeEventListener('pointerup', up);
      release(next.clientY - start, reducedMotion() ? 0 : (next.clientY - start) / Math.max(1, next.timeStamp - began));
    };
    addEventListener('pointermove', follow);
    addEventListener('pointerup', up);
  }

  page.addEventListener('touchstart', onTouchStart, { passive: true });
  page.addEventListener('touchmove', onTouchMove, { passive: false });
  page.addEventListener('touchend', onTouchEnd);
  page.addEventListener('touchcancel', onTouchEnd);
  page.addEventListener('pointerdown', onPointerDown);
  return () => {
    page.removeEventListener('touchstart', onTouchStart);
    page.removeEventListener('touchmove', onTouchMove);
    page.removeEventListener('touchend', onTouchEnd);
    page.removeEventListener('touchcancel', onTouchEnd);
    page.removeEventListener('pointerdown', onPointerDown);
  };
}
