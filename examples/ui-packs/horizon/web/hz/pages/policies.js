// Policies: each vehicle's service schedule. Recordings older than the days you
// set move to the Recycle Bin once a day; protected ones are always skipped.
import { h, ico, api, app, car, size, count, stamp, toast, ask, act, pill, panelHead, blank } from '../core.js';

const CATS = [['Recent', 'cyan'], ['Sentry', 'org'], ['Saved', 'grn'], ['Other', '']];

export default {
  async mount(el, { status }) {
    async function draw() {
      if (!app.vehicles.length) {
        el.innerHTML = `<section class="ptitle hud"><div><h1 class="chrome">Policies</h1></div></section><section class="panel hud">${blank('Add a vehicle first.', `<a class="btn go" href="#/settings/vehicles?add=1">${ico('plus')}Add a vehicle</a>`)}</section>`;
        return;
      }
      const all = await Promise.all(app.vehicles.map(async (v) => [v, await api(`/api/vehicles/${encodeURIComponent(v.id)}/policy`).catch((err) => ({ error: err.message }))]));
      const cur = car();
      el.innerHTML = `<section class="ptitle hud"><div><h1 class="chrome">Policies</h1><p>A service schedule per vehicle: recordings older than the days you set move to the Recycle Bin once a day. A policy never deletes anything, and protected recordings are always skipped. Leave a field empty to keep that kind forever.</p></div></section>
        <div class="cols">${all.map(([v, d]) => {
          if (d.error) return `<section class="panel hud">${panelHead(h(v.name))}<p class="badtx">${h(d.error)}</p></section>`;
          const p = d.policy;
          const pv = d.preview || {};
          return `<form class="panel hud form pol${v.id === cur?.id ? ' cyan' : ''}" data-v="${h(v.id)}">
            ${panelHead(`${ico('policy')}${h(v.name)}`, p.enabled ? pill('runs daily', 'grn') : pill('off', ''))}
            <label class="chk"><input type="checkbox" name="enabled"${p.enabled ? ' checked' : ''}> Run this policy every day</label>
            <div class="keep">${CATS.map(([c, tone]) => `<label class="fld keep-i k-${tone || 'none'}"><span>${c}</span><span class="keep-in"><input class="in num" type="number" inputmode="numeric" min="1" max="3650" name="keep-${c}" value="${h(p.keepDays?.[c] ?? '')}" placeholder="forever" aria-label="Keep ${c} recordings for this many days"><span class="small faint">days</span></span></label>`).join('')}</div>
            <label class="fld" style="max-width:220px">Run at (server time)<input class="in num" type="time" name="runAt" value="${h(p.runAt || '03:30')}"></label>
            <div class="note ${pv.recordings ? 'org' : ''}">${pv.recordings ? `With the saved settings the next run moves <b>${count(pv.recordings, 'recording')}</b> (<b>${size(pv.bytes)}</b>) to the Recycle Bin.` : 'With the saved settings nothing would move right now.'}
              ${p.lastRunAt ? `<br><span class="small">Last run ${h(stamp(p.lastRunAt))}: ${p.lastResult?.error ? h(p.lastResult.error) : h(`${p.lastResult?.moved ?? 0} moved, ${p.lastResult?.skipped ?? 0} skipped`)}.</span>` : ''}</div>
            <div class="row"><button class="btn go" type="submit">Save policy</button><button class="btn" type="button" data-run>${ico('play')}Run now…</button></div>
          </form>`;
        }).join('')}</div>`;
      status(`${all.filter(([, d]) => d.policy?.enabled).length} of ${count(all.length, 'vehicle')} on a schedule`);
      el.querySelectorAll('form.pol').forEach((form) => {
        const id = form.dataset.v;
        const read = () => {
          const fd = new FormData(form);
          return { enabled: fd.get('enabled') === 'on', runAt: fd.get('runAt') || '03:30', keepDays: Object.fromEntries(CATS.map(([c]) => [c, fd.get(`keep-${c}`) ? Number(fd.get(`keep-${c}`)) : null])) };
        };
        form.onsubmit = (e) => {
          e.preventDefault();
          act(form.querySelector('[type=submit]'), async () => {
            await api(`/api/vehicles/${encodeURIComponent(id)}/policy`, { method: 'PUT', body: read() });
            toast('Policy saved.');
            await draw();
          });
        };
        form.querySelector('[data-run]').onclick = (e) => act(e.currentTarget, async () => {
          await api(`/api/vehicles/${encodeURIComponent(id)}/policy`, { method: 'PUT', body: read() });
          const d = await api(`/api/vehicles/${encodeURIComponent(id)}/policy`);
          if (!d.preview?.recordings) { toast('Nothing to move right now.'); await draw(); return; }
          if (!(await ask({ title: 'Run the policy now?', body: `<p>${count(d.preview.recordings, 'recording')} (<b>${size(d.preview.bytes)}</b>) move to the Recycle Bin. You can restore them from there.</p>`, yes: 'Run now' }))) return;
          const out = await api(`/api/vehicles/${encodeURIComponent(id)}/policy/run`, { body: {} });
          toast(`${count(out.moved?.length ?? 0, 'recording')} moved to the Recycle Bin.`);
          await draw();
        });
      });
    }
    await draw();
    return {
      onTopics(t) { if ((t.includes('inventory') || t.includes('vehicles')) && !el.contains(document.activeElement)) draw().catch(() => {}); },
      onCar() { el.querySelector(`form.pol[data-v="${CSS.escape(car()?.id || '')}"]`)?.scrollIntoView({ block: 'start' }); }
    };
  }
};
