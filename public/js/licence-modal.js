// Opens the Suite licence in a modal <dialog> from any a[data-licence-modal].
// Without showModal support the link is left alone and navigates to the Hub page.
import {
  LICENCE_TITLE,
  LICENCE_VERSION,
  LICENCE_EFFECTIVE,
  LICENCE_HTML,
} from './licence-text.js';

let dialog = null;
let trigger = null;

function buildDialog() {
  const el = document.createElement('dialog');
  el.className = 'licence-modal';
  el.setAttribute('aria-labelledby', 'licence-modal-title');
  el.innerHTML = `
    <header class="licence-modal__head">
      <h2 id="licence-modal-title" tabindex="-1">${LICENCE_TITLE}</h2>
      <p class="licence-modal__meta">Version ${LICENCE_VERSION} · Effective ${LICENCE_EFFECTIVE}</p>
    </header>
    <div class="licence-modal__body">${LICENCE_HTML}</div>
    <footer class="licence-modal__foot">
      <button type="button" class="btn btn-ghost licence-modal__close">Close</button>
    </footer>`;
  el.querySelector('.licence-modal__close').addEventListener('click', () => el.close());
  el.addEventListener('click', (e) => {
    if (e.target === el) el.close();
  });
  el.addEventListener('close', () => {
    if (trigger && trigger.isConnected) trigger.focus();
    trigger = null;
  });
  document.body.appendChild(el);
  return el;
}

function openLicence(link) {
  if (!dialog) dialog = buildDialog();
  if (dialog.open) return;
  trigger = link;
  dialog.showModal();
  dialog.querySelector('.licence-modal__body').scrollTop = 0;
  dialog.querySelector('#licence-modal-title').focus();
}

if (typeof HTMLDialogElement === 'function' && 'showModal' in HTMLDialogElement.prototype) {
  document.addEventListener('click', (e) => {
    const link = e.target instanceof Element && e.target.closest('a[data-licence-modal]');
    if (!link || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    openLicence(link);
  });
}
