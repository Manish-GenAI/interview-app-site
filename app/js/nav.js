// Shared navigation state (kept separate from app.js to avoid import cycles).
let guard = null;

/** While set, leaving the page (or the route) asks for confirmation. */
export function setLeaveGuard(message) { guard = message || null; }
export function getLeaveGuard() { return guard; }

export function navigate(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

window.addEventListener('beforeunload', (e) => {
  if (guard) { e.preventDefault(); e.returnValue = guard; }
});
