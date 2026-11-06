// Which addresses this device can really open. A loopback address names the machine you are
// holding, so on a phone it would point at the phone. It is shown on the Mac and nowhere else.

const LOOPBACK_HOST = /^(?:127(?:\.\d+){3}|localhost|\[?::1\]?)$/i;
const LOOPBACK_URL = /https?:\/\/(?:127(?:\.\d+){3}|localhost|\[::1\])(?::\d+)?[^\s,)]*/gi;

export const onTheMac = () => LOOPBACK_HOST.test(location.hostname);

export function isLoopback(url) {
  try {
    return LOOPBACK_HOST.test(new URL(url, location.href).hostname);
  } catch {
    return false;
  }
}

/** A sim's relative address is fine anywhere. A loopback one is only fine on the Mac. */
export const canOpen = (url) => onTheMac() || !isLoopback(url);

export const shortAddress = (url) => String(url).replace(/^https?:\/\//, '').replace(/\/$/, '');

/** Text that may quote a loopback address, made safe to show on this device. */
export const quietLoopback = (text) => (onTheMac() ? text : String(text ?? '').replace(LOOPBACK_URL, 'on your Mac'));
