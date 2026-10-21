import { applyThemeToElement, getStoredTheme, THEME_KEY } from '../runtime/theme.js';
import { subscribeLocalKey } from '../runtime/localStore.js';

// Match the paper/ink palette and Voice/Data typography in modal.css and content.css.
// Define tokens on this host so an article's styles cannot change the dialog palette.
const STYLES = `
  :host {
    all: initial;
    color-scheme: light dark;
    --ink: light-dark(#000, #f4f5f7);
    --accent: light-dark(#3a404d, #aab2c0);
    --surface: light-dark(#fff, #1b1d22);
    --surface-low: light-dark(#f2f3f5, #141519);
    --on-surface: light-dark(#141414, #ececec);
    --on-surface-muted: light-dark(#5f646b, #a0a6af);
    --ghost: light-dark(rgb(0 0 0 / 20%), rgb(255 255 255 / 22%));
    --font-voice: georgia, 'Times New Roman', times, serif;
    --font-data: -apple-system, blinkmacsystemfont, 'Segoe UI', roboto, oxygen,
      ubuntu, cantarell, 'Helvetica Neue', helvetica, arial, sans-serif;
  }
  :host([data-theme='light']) { color-scheme: light; }
  :host([data-theme='dark']) { color-scheme: dark; }
  *, *::before, *::after { box-sizing: border-box; }
  dialog {
    width: min(520px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    overflow: auto;
    padding: 0;
    border: 2px solid var(--ink);
    border-radius: 0;
    background: var(--surface);
    color: var(--on-surface);
    box-shadow: 6px 6px 0 rgb(0 0 0 / 12%);
    font: 14px/1.5 var(--font-data);
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  dialog::backdrop { background: rgb(0 0 0 / 45%); }
  header { padding: 16px 20px; border-bottom: 2px solid var(--ink); }
  h2 {
    margin: 0 0 6px;
    color: var(--ink);
    font: 800 24px/1.15 var(--font-voice);
    letter-spacing: -0.02em;
  }
  p { margin: 0; overflow-wrap: anywhere; }
  #resplit-target { color: var(--on-surface-muted); font-size: 12px; }
  .instructions { padding: 16px 20px 20px; }
  #resplit-description { font-size: 13px; }
  label {
    display: block;
    margin: 16px 0 6px;
    color: var(--ink);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  textarea {
    display: block;
    width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--ghost);
    border-radius: 0;
    background: var(--surface-low);
    color: var(--on-surface);
    font: 13px/1.4 var(--font-data);
    resize: vertical;
  }
  textarea::placeholder { color: var(--on-surface-muted); opacity: 1; }
  .note { margin-top: 12px; color: var(--on-surface-muted); font-size: 12px; }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid var(--ghost);
    background: var(--surface-low);
  }
  button {
    appearance: none;
    min-height: 34px;
    padding: 7px 14px;
    border: 1px solid var(--ink);
    border-radius: 0;
    background: var(--surface);
    color: var(--ink);
    font: 800 11px/1.4 var(--font-data);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    cursor: pointer;
  }
  button:hover { background: var(--ink); color: var(--surface); }
  button[type="submit"] { background: var(--ink); color: var(--surface); }
  button[type="submit"]:hover { background: var(--surface); color: var(--ink); }
  :focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
`;

/** Collect optional guidance before resplitting in any topic view.
 * The isolated dialog also works on pages with their own styles and shortcuts.
 * Cancelling discards its inputs. Submitted guidance is kept on the record only
 * until this resplit run completes, so a resumed or retried run still applies it.
 * @param {object} options Dialog context.
 * @param {object} options.topic Selected topic and sentence range.
 * @param {boolean} options.hasSubtopics Whether existing subtopics will be replaced.
 * @returns {Promise<{splittingInstructions: string, summaryInstructions: string}|null>}
 */
export function showResplitInstructionsDialog({ topic, hasSubtopics }) {
  return new Promise((resolve) => {
    const previous = document.activeElement?.shadowRoot?.activeElement || document.activeElement;
    const host = document.createElement('div');
    host.id = 'pagetollm-resplit-dialog';
    // Use the current extension surface's preference immediately, then sync with storage.
    const surface = document.getElementById('pagetollm-in-page-rail') || document.documentElement;
    applyThemeToElement(host, surface.getAttribute('data-theme'));
    let finished = false;
    let themeChanged = false;
    const stopWatchingTheme = subscribeLocalKey(THEME_KEY, (preference) => {
      themeChanged = true;
      if (!finished) applyThemeToElement(host, preference);
    });
    void getStoredTheme().then((preference) => {
      if (!finished && !themeChanged) applyThemeToElement(host, preference);
    });
    // Match the capture toolbar: page scripts must not read or alter user guidance.
    const shadow = host.attachShadow({ mode: 'closed' });
    // Only static markup goes through innerHTML. Topic names are assigned as text below.
    shadow.innerHTML = `
      <style>${STYLES}</style>
      <dialog aria-labelledby="resplit-title" aria-describedby="resplit-target resplit-description">
        <form>
          <header>
            <h2 id="resplit-title">Resplit topic</h2>
            <p id="resplit-target"></p>
          </header>
          <div class="instructions">
            <p id="resplit-description"></p>
            <label for="resplit-splitting-instructions">Splitting instructions (optional)</label>
            <textarea id="resplit-splitting-instructions" rows="3"
              placeholder="How should this topic be split?" autofocus></textarea>
            <label for="resplit-summary-instructions">Summary instructions (optional)</label>
            <textarea id="resplit-summary-instructions" rows="3"
              placeholder="What should the new summaries focus on?"></textarea>
            <p class="note">Instructions apply to this run only and are discarded when it completes.</p>
          </div>
          <div class="actions">
            <button type="button">Cancel</button>
            <button type="submit">Resplit</button>
          </div>
        </form>
      </dialog>
    `;
    const dialog = shadow.querySelector('dialog');
    shadow.querySelector('#resplit-target').textContent =
      `${topic.path} · Sentences ${topic.startSentence}–${topic.endSentence}`;
    shadow.querySelector('#resplit-description').textContent = hasSubtopics
      ? 'Resplitting may rename this topic and replaces its subtopics within this sentence range.'
      : 'Resplitting may rename this topic and create new subtopics within this sentence range.';
    const finish = (value) => {
      finished = true;
      stopWatchingTheme();
      dialog.close();
      host.remove();
      if (previous?.isConnected) previous.focus();
      resolve(value);
    };
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(null);
    });
    dialog.addEventListener('keydown', (event) => event.stopPropagation());
    shadow.querySelector('button[type="button"]').addEventListener('click', () => finish(null));
    shadow.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      finish({
        splittingInstructions: shadow.querySelector('#resplit-splitting-instructions').value.trim(),
        summaryInstructions: shadow.querySelector('#resplit-summary-instructions').value.trim(),
      });
    });
    document.body.append(host);
    dialog.showModal();
    shadow.querySelector('textarea').focus();
  });
}
