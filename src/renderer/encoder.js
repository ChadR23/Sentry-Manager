// encoder.html: Sentry Studio's converter on a page of its own (the Encoder
// tab of Sentry Six Manager). The converter controller is the same as in the
// viewer (scripts/features/footageConverter.js, driven through the same
// element IDs); this page only starts it. Until the converter shows its last
// job, its stylesheets and fonts have arrived and the manager's setup is done
// (the vehicle picker and the source, in electronApiShim.js), the page shows
// the skeleton in its markup, so a slow connection never shows anything
// half-built.
import { initFootageConverter } from './scripts/features/footageConverter.js';
import { notify } from './scripts/ui/notifications.js';

const root = document.documentElement;
const api = window.electronAPI;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The stylesheets are only preloaded in the head (they never hold up the
// skeleton); applied now, in their order, while the converter is hidden.
const styles = Promise.all([...document.querySelectorAll('link[rel="preload"][as="style"]')].map((preload) => new Promise((resolve) => {
    const sheet = document.createElement('link');
    sheet.rel = 'stylesheet';
    sheet.href = preload.href;
    sheet.addEventListener('load', resolve, { once: true });
    sheet.addEventListener('error', resolve, { once: true });
    document.head.append(sheet);
})));

// Text and icons in their own fonts from the start (icons are a font: before
// it arrives they would show as their names).
const fonts = styles.then(() => Promise.all([
    '20px "Material Symbols Outlined"', '13px Inter', '600 13px Inter', '13px "JetBrains Mono"'
].map((font) => document.fonts?.load?.(font).catch(() => null))));

// Translations. The converter's strings are English in every language, and
// the translation table is large (about 330 KB), so it is only fetched for
// another language, after the page is shown; until then the controller uses
// its English texts.
let i18n = null;
const languageListeners = new Set();
const t = (key, params) => (i18n ? i18n.t(key, params) : key);
const onLanguageChange = (listener) => {
    languageListeners.add(listener);
    return () => languageListeners.delete(listener);
};
async function loadLanguage() {
    const saved = await Promise.resolve(api?.getSetting?.('language')).catch(() => null);
    if (/^en(-|$)/i.test(String(saved || navigator.language || 'en'))) return;
    i18n = await import('./scripts/lib/i18n.js');
    i18n.onLanguageChange((lang) => languageListeners.forEach((listener) => listener(lang)));
    await i18n.initI18n();
}

// On one column the Live run panel moves above the settings while a job runs
// (encoderPage.css); after Start, scroll up to it.
function followRun() {
    const startButton = document.getElementById('converterStart');
    const panel = document.querySelector('.converter-operations');
    if (!startButton || !panel) return;
    let pressedAt = 0;
    startButton.addEventListener('click', () => { pressedAt = Date.now(); });
    new MutationObserver(() => {
        if (!startButton.disabled || Date.now() - pressedAt > 15000) return;
        pressedAt = 0;
        if (!matchMedia('(max-width: 980px)').matches) return;
        const top = panel.getBoundingClientRect().top + window.scrollY - 12;
        window.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }).observe(startButton, { attributes: true, attributeFilter: ['disabled'] });
}

async function start() {
    let controller = null;
    try {
        controller = await initFootageConverter({ api, root: document, notify, t, onLanguageChange });
        controller.setVisible(true);
    } catch (error) {
        console.error('Converter failed to start', error);
        notify(`The encoder could not start (${error?.code || error?.message || 'error'}). Reload the page to try again.`, { type: 'error', timeoutMs: 0, dismissible: true });
    }

    // The manager's setup (electronApiShim.js) runs now, with the last job's
    // settings in place; it may ask the page to wait for it (waitUntil).
    const pending = [];
    window.dispatchEvent(new CustomEvent('sentry:converter-ready', {
        detail: {
            jobState: () => controller?.snapshot?.state ?? null,
            waitUntil: (promise) => pending.push(promise)
        }
    }));
    await Promise.race([Promise.allSettled(pending), wait(5000)]);
    await styles;
    await Promise.race([fonts, wait(3000)]);

    // Back on the Encoder from the manager's other pages: a node paired,
    // renamed or removed under Nodes (or its number set there) shows in the
    // rows without reloading the page.
    window.addEventListener('message', async (event) => {
        if (event.source !== window.parent || event.origin !== location.origin || event.data?.type !== 'shown') return;
        if ((await controller?.refreshDevices()) === 'reload') location.reload();
    });

    root.classList.remove('enc-loading');
    root.classList.add('enc-ready');
    followRun();
    loadLanguage().catch(() => {});
}

start();
