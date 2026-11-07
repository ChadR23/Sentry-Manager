'use strict';

// The built-in Viewer's translations, one language at a time. Its
// translations.js holds every language (340 KB, 13 languages); the page gets
// a version of it with English only and a placeholder for each other
// language, and i18n.js fetches the one it shows (/studio/i18n/<lang>.json)
// when it is first needed. The Studio file itself is unchanged; this reads it
// (an ES module) once, and again only if it changes.

const fsp = require('fs/promises');
const crypto = require('crypto');

function createStudioTranslations(file) {
  let cache = null;
  async function load() {
    const st = await fsp.stat(file);
    const stamp = `${st.size}-${Math.round(st.mtimeMs)}`;
    if (cache?.stamp === stamp) return cache;
    const src = await fsp.readFile(file, 'utf8');
    const { translations } = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
    const langs = Object.keys(translations);
    const tag = crypto.createHash('sha1').update(src).digest('hex').slice(0, 16);
    cache = {
      stamp,
      etag: `W/"tr-${tag}"`,
      module: `// English here; other languages: /studio/i18n/<lang>.json (server/studioTranslations.js)\nexport const translations = ${JSON.stringify(Object.fromEntries(langs.map((l) => [l, l === 'en' ? translations.en : null])))};\n`,
      json: new Map(langs.map((l) => [l, JSON.stringify(translations[l])]))
    };
    return cache;
  }
  return {
    /** The module the page imports: English, and a null for every other language. */
    async module() { const c = await load(); return { body: c.module, etag: c.etag }; },
    /** One language, as JSON, or null if there is no such language. */
    async language(lang) {
      const c = await load();
      return c.json.has(lang) ? { body: c.json.get(lang), etag: `${c.etag.slice(0, -1)}-${lang}"` } : null;
    }
  };
}

module.exports = { createStudioTranslations };
