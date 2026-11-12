import { ownedRender } from '../core.js';
import { esc, act } from '../core.js';
import { icon } from '../icons.js';
import { size, ago, plural } from '../format.js';
import { forms } from './settings/forms.js';
const groups = [
  [
    'Your car',
    [
      ['vehicles', 'Vehicles', 'directions_car'],
      ['places', 'Places', 'location_on'],
      ['cleanup', 'Cleanup rules', 'delete_sweep'],
      ['encoding', 'Encoding per car', 'conversion_path'],
    ],
  ],
  [
    'This app',
    [
      ['notifications', 'Notifications', 'notifications'],
      ['look', 'Look & interface', 'palette'],
      ['helpers', 'Helper servers', 'dns'],
    ],
  ],
  [
    'Server',
    [
      ['updates', 'Updates', 'system_update'],
      ['security', 'Security & HTTPS', 'shield'],
      ['system', 'System', 'memory'],
      ['power', 'Electricity price', 'bolt'],
      ['advanced', 'Advanced', 'tune'],
    ],
  ],
  ['Support', [['help', 'Help & feedback', 'help']]],
];
async function renderPage(el, ctx) {
  const { api, confirmDialog, confirmPassword, toast, fetch } = ctx.scope;
  const { state } = ctx;
  const me = await api('/api/auth/me');
  const admin = me.role === 'admin';
  const sub = ctx.sub?.replace(/^interface$/, 'look') || '',
    editing = sub === 'vehicle-new' ? 'new' : sub.startsWith('vehicle/') ? sub.slice(8) : null,
    key = editing ? 'vehicles' : sub || (admin ? 'vehicles' : 'account');
  // Account is independent of server settings and always remains reachable.
  const paths = {
    updates: ['/api/updates'],
    security: ['/api/security'],
    system: ['/api/system'],
    power: ['/api/settings', '/api/system'],
    look: ['/api/settings', '/api/ui-packs'],
    notifications: ['/api/notification-rules'],
  };
  let unavailable = !admin && key !== 'account';
  let loadError = '';
  const data = {};
  if (!unavailable)
    await Promise.all(
      (paths[key] || []).map(async (path) => {
        try {
          data[path] = await api(path);
        } catch (e) {
          unavailable = true;
          loadError = e.status === 403 ? '' : e.message;
        }
      }),
    );
  if (!ctx.alive()) return;
  const settings = data['/api/settings'] || {},
    upd = data['/api/updates'] || {},
    sys = data['/api/system'] || {},
    sec = data['/api/security'] || {},
    ui = data['/api/ui-packs'] || { packs: [] },
    rules = data['/api/notification-rules'] || { rules: [] };
  if (data['/api/system']) state.system = sys;
  if (settings.power) state.power = settings.power;
  const values = {
    vehicles: state.vehicles.map((v) => v.name).join(', ') || 'Add a vehicle',
    look: 'Sentry Six',
  };
  el.innerHTML = `<div class="settings-layout ${sub ? 'detail-open' : ''}"><nav class="settings-nav" aria-label="Settings"><a class="account-card" href="#/settings/account"><span class="avatar">${esc((me.user || '?')[0].toUpperCase())}</span><span><b>${esc(me.user || 'Account')}</b><small>${esc(me.role || '')}</small></span><span>›</span></a>${(admin ? groups : []).map(([g, rows]) => `<h3>${g}</h3><div class="settings-group">${rows.map(([k, label, glyph]) => `<a href="#/settings/${k}" class="${key === k ? 'active' : ''}">${icon(glyph)}<span>${label}</span><small data-summary="${k}">${esc(k === 'vehicles' || k === 'look' ? values[k] || '' : '')}</small><span>›</span></a>`).join('')}</div>`).join('')}</nav><section class="settings-detail"><a class="settings-back" href="#/settings">‹ Settings</a><div data-detail></div></section></div>`;
  // Summary failures and slow endpoints never hold up the list or Account.
  let summariesStopped = false;
  const vehicle = ctx.current();
  const summaries = {
    places: ['/api/places', (d) => `${(d.places || []).length.toLocaleString()} saved`],
    ...(vehicle
      ? {
          cleanup: [
            `/api/vehicles/${encodeURIComponent(vehicle.id)}/policy`,
            (d) => (d.policy?.enabled ? 'On' : 'Off'),
          ],
        }
      : {}),
    encoding: ['/api/vehicles', (d) => plural((d.vehicles || []).length, 'vehicle')],
    notifications: [
      '/api/notification-rules',
      (d) => `${(d.rules || []).filter((r) => r.on).length.toLocaleString()} on`,
    ],
    helpers: ['/api/nodes', (d) => `${(d.nodes || []).length.toLocaleString()} paired`],
    updates: [
      '/api/updates',
      (d) =>
        d.updateAvailable
          ? 'Update available'
          : d.enabled
            ? d.latest
              ? 'Up to date'
              : 'Not checked'
            : 'Source build',
    ],
    security: ['/api/security', (d) => (d.https ? 'HTTPS' : 'HTTP')],
    system: ['/api/system', (d) => (d.converter?.ready ? 'Ready' : 'Starting')],
    power: [
      '/api/settings',
      (d) =>
        d.power?.mode === 'tou'
          ? 'Time of use'
          : d.power?.pricePerKwh != null
            ? `${d.power.currency} ${d.power.pricePerKwh}/kWh`
            : 'Not set',
    ],
    advanced: ['/api/metrics/settings', (d) => (d.enabled ? 'On' : 'Off')],
    help: ['/api/reports', (d) => (d.settings?.share ? 'Sharing on' : 'Off')],
  };
  if (admin)
    void Promise.allSettled(
      Object.entries(summaries).map(async ([key, [path, label]]) => {
        const result = await api(path);
        if (!ctx.alive() || summariesStopped) return;
        const row = el.querySelector(`[data-summary="${key}"]`);
        if (row) row.textContent = label(result);
      }),
    );
  const box = el.querySelector('[data-detail]'),
    f = forms(box, ctx);
  let shared;
  try {
    if (unavailable) {
      box.innerHTML = `<div class="card">${esc(loadError || 'This page is not available to this account.')} <a href="#/settings/account">Open Account</a></div>`;
    } else if (key === 'vehicles') {
      box.innerHTML = `<div class="card"><div class="row"><h2 class="grow">Vehicles</h2><a class="btn" href="#/settings/vehicle-new">Add vehicle</a></div>${state.vehicles.map((v) => `<div class="health-check row"><div class="grow"><b>${esc(v.name)}</b><p>${esc(v.timezone)} · ${v.share?.healthy ? (v.share.writable === false ? 'Read-only' : 'Connected') : 'Unavailable'}</p><p>${esc(v.source.type === 'smb' ? v.source.share : v.source.path)}</p></div><a href="#/settings/vehicle/${encodeURIComponent(v.id)}">Edit</a></div>`).join('') || '<p>Add the car and the folder where its footage arrives.</p>'}${editing ? f.vehicleForm(editing === 'new' ? null : state.vehicles.find((v) => v.id === editing)) : ''}</div>`;
      f.wireSettings(editing);
    } else if (key === 'account') {
      box.innerHTML =
        '<div class="card"><div class="row"><h2 class="grow">Account</h2><button data-signout>Sign out</button></div><form id="pw" class="form"><label class="field">Current password<input type="password" name="current" autocomplete="current-password" required></label><label class="field">New password<input type="password" name="next" autocomplete="new-password" minlength="8" required></label><div class="full"><button class="primary">Change password</button></div></form></div><div class="card" data-shared></div>';
      shared = (await ctx.scope.wait(import('/web/account.js'))).createAccountPage(
        box.querySelector('[data-shared]'),
        {
          scope: ctx.scope,
        },
      );
      f.wireSettings(null);
      box.querySelector('[data-signout]').onclick = act(async () => {
        await api('/api/auth/logout', { method: 'POST' });
        location.href = '/login';
      });
    } else if (key === 'cleanup')
      shared = {
        destroy: await (await ctx.scope.wait(import('./settings/cleanup.js'))).render(box, ctx),
      };
    else if (key === 'helpers')
      shared = {
        destroy: await (await ctx.scope.wait(import('./settings/helpers.js'))).render(box, ctx),
      };
    else if (key === 'updates') {
      box.innerHTML = f.updatesCard(upd, await ctx.scope.wait(import('/web/buildLabel.js')));
      f.wireSettings(null);
    } else if (key === 'security') {
      box.innerHTML = f.securityCard(sec);
      f.wireSecurity(sec);
    } else if (key === 'power') {
      box.innerHTML = f.powerCard(settings.power || {}, sys.timezone);
      f.wirePower(settings.power || {});
    } else if (key === 'system') {
      const c = sys.converter || {},
        g = sys.gpu || {};
      box.innerHTML = `<div class="card"><h2>System</h2><dl class="kv"><dt>Converter</dt><dd>${c.ready ? 'Ready' : esc(c.error || 'Starting')}</dd><dt>Replace originals</dt><dd>${esc(c.capabilities?.replacement || 'Unavailable')}</dd><dt>Ownership cleanup</dt><dd>${esc(c.capabilities?.ownershipCleanup || 'Unavailable')}</dd><dt>Safe rename helper</dt><dd>${sys.nativeHelper ? 'Installed' : 'Link and unlink fallback'}</dd><dt>Data volume free</dt><dd>${size(sys.dataFree)}</dd><dt>Server time zone</dt><dd>${esc(sys.timezone)}</dd><dt>Graphics</dt><dd>${
        [
          ...(g.nvidia || []).map((x) => `${esc(x.name)} · driver ${esc(x.driver)}`),
          ...(g.gpus || [])
            .filter((x) => x.vendor !== 'nvidia')
            .map(
              (x) =>
                `${esc(x.name || x.vendorName)} · ${esc(x.node)} · ${x.virtual ? 'Virtual device; not used for encoding' : x.passedThrough ? 'Passed into container' : 'Not passed into container'}${
                  x.encodes
                    ? ' · encodes ' +
                      Object.entries(x.encodes)
                        .filter(([, on]) => on)
                        .map(([k]) => esc(k.toUpperCase()))
                        .join(', ')
                    : ''
                }`,
            ),
        ].join('<br>') || 'CPU encoders'
      }${(g.hints || []).map((h) => `<p>${esc(h)}</p>`).join('')}</dd></dl><a href="#/health/server">Server details →</a></div>`;
    } else if (key === 'places') {
      box.innerHTML = '<div class="card"><h2>Places</h2><div data-shared></div></div>';
      shared = (await ctx.scope.wait(import('/web/placesSettings.js'))).createPlacesSettings(
        box.querySelector('[data-shared]'),
        {
          scope: ctx.scope,
          cls: {
            btn: 'btn',
            primary: 'btn primary',
            danger: 'btn danger',
            input: 'input',
            muted: 'muted',
          },
          toast,
          confirm: (o) => confirmDialog({ ...o, danger: true }),
        },
      );
    } else if (key === 'help') {
      box.innerHTML = '<div class="card"><h2>Help & feedback</h2><div data-shared></div></div>';
      shared = (await ctx.scope.wait(import('/web/reportsSettings.js'))).createReportsSettings(
        box.querySelector('[data-shared]'),
        {
          scope: ctx.scope,
          cls: { btn: 'btn', primary: 'btn primary', input: 'input' },
          h24: () => state.h24,
        },
      );
    } else if (key === 'encoding') {
      box.innerHTML = '<div data-shared></div>';
      if (!window.SentryVehicleEncoding)
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = '/web/vehicleEncoding.js';
          s.onload = resolve;
          s.onerror = () => reject(new Error('Could not load encoding settings.'));
          document.head.append(s);
        });
      if (ctx.alive()) {
        shared = window.SentryVehicleEncoding.mount(box.querySelector('[data-shared]'), {
          scope: ctx.scope,
          classes: {
            card: 'card',
            btn: 'btn',
            primary: 'btn primary',
            input: 'input',
            field: 'field',
            check: 'check',
            muted: 'muted',
          },
          toast,
          encoderHref: '#/encoder',
          confirm: (text) =>
            confirmDialog({
              title: 'Replace originals?',
              body: `<p>${esc(text)}</p>`,
              ok: 'Replace originals',
              danger: true,
            }),
        });
        await shared.ready;
      }
    } else if (key === 'notifications') {
      const labels = {
        share: 'Footage share offline or read-only',
        storage: 'Share running out of space',
        server: 'Server hardware',
        health: 'Startup check failures',
        conversion: 'Conversions that fail',
        update: 'New versions',
        archive: 'Footage that has not reached the share',
      };
      box.innerHTML =
        '<div class="card"><h2>Notifications</h2><p>Choose which kinds make notifications. The critical-update bar always shows.</p>' +
        rules.rules
          .map(
            (r) =>
              `<label class="setting-row"><span>${esc(labels[r.kind] || r.kind)}</span><input type="checkbox" data-rule="${esc(r.kind)}" ${r.on ? 'checked' : ''}></label>`,
          )
          .join('') +
        '</div>';
      box.onchange = act(async () => {
        await api('/api/notification-rules', {
          method: 'PUT',
          body: {
            rules: Object.fromEntries(
              [...box.querySelectorAll('[data-rule]')].map((e) => [e.dataset.rule, e.checked]),
            ),
          },
        });
        toast('Notification preferences saved.');
      });
    } else if (key === 'advanced') {
      async function draw(token) {
        const m = await api('/api/metrics/settings');
        if (!ctx.alive()) return;
        box.innerHTML = `<div class="card"><h2>Advanced</h2><h3>Metrics for your own monitoring</h3><p>Read-only numbers for Prometheus, Grafana or Home Assistant. Off until enabled; the token is required. Uses this server's existing port.</p><p>${m.enabled ? 'On' : 'Off'}</p>${
          token
            ? `<p>Token shown once. Keep it like a password.</p><code class="secret">${esc(token)}</code><pre>- job_name: sentry-six-manager
scheme: ${location.protocol.slice(0, -1)}
static_configs: [{ targets: ['${esc(location.host)}'] }]
authorization: { credentials: '${esc(token)}' }</pre><p>For HTTPS, install the <a href="#/settings/security">local certificate authority</a> in your monitoring client.</p>`
            : ''
        }${m.enabled ? `<p>Metrics endpoint: <code>${esc(location.origin)}/metrics</code></p><button data-off>Turn off</button> ` : ''}<button data-on>${m.enabled ? 'New token' : 'Turn on…'}</button></div>`;
        box.onclick = act(async (e) => {
          if (e.target.closest('[data-on]')) {
            await confirmPassword();
            const d = await api('/api/metrics/enable', { method: 'POST' });
            await draw(d.token);
          }
          if (e.target.closest('[data-off]')) {
            await confirmPassword();
            await api('/api/metrics/disable', { method: 'POST' });
            await draw();
          }
        });
      }
      await draw();
    } else if (key === 'look') {
      box.innerHTML = `<div class="card"><h2>Look & interface</h2><label class="setting-row">Glass effect <input type="range" min="0" max="100" value="${state.glass}" data-glass></label><label class="setting-row">24-hour clock <input type="checkbox" class="toggle-switch" role="switch" data-clock ${state.h24 ? 'checked' : ''}></label><label class="setting-row">Reduce motion and effects <input type="checkbox" class="toggle-switch" role="switch" data-reduce ${settings.appearance?.reduceEffects ? 'checked' : ''}></label><label class="setting-row">Units <select data-units><option value="mi">Miles · °F · psi</option><option value="km" ${globalThis.SentryUnits.metric() ? 'selected' : ''}>Kilometres · °C · bar</option></select></label></div><h3>Interface for everyone</h3><div class="pack-grid">${[{ id: '', name: 'Original', description: 'The built-in interface' }, ...ui.packs].map((p, i) => `<div class="pack-card ${p.id === (ui.active || '') ? 'in-use' : ''}"><button data-pack="${esc(p.id)}" ${p.id === (ui.active || '') ? 'disabled' : ''}><span class="pack-preview" style="--preview-hue:${[145, 150, 260, 210, 35, 175][i % 6]}"><i></i><span><b></b><b></b><b></b></span></span><strong>${esc(p.name)}</strong><small>${p.id === (ui.active || '') ? '✓ In use' : 'Use this interface'}</small></button><p>${esc(p.description || '')}</p>${p.builtin === false ? `<button class="danger" data-delete-pack="${esc(p.id)}">Delete pack</button>` : ''}</div>`).join('')}</div><div class="toolbar"><input type="file" accept=".zip,application/zip" hidden data-file><button data-upload>Upload a pack…</button><a href="/api/ui-packs/original.zip" download>Download Original</a></div><p>Something wrong? <a href="/original">Open Original in this browser</a>.</p>`;
      const use = async (id) => {
        await confirmPassword();
        await api('/api/ui-packs/active', {
          method: 'PUT',
          body: { id: id || null },
        });
        location.reload();
      };
      box.querySelector('[data-glass]').oninput = (e) => {
        state.glass = Number(e.target.value);
        localStorage.setItem('s6:glass', state.glass);
        document.documentElement.classList.toggle('no-glass', !state.glass);
        document.documentElement.style.setProperty('--lg-glass', state.glass / 50);
        document.documentElement.style.setProperty('--lg-glow', state.glass / 50);
      };
      box.querySelector('[data-clock]').onchange = act(async (e) => {
        await api('/api/settings/appearance', {
          method: 'PUT',
          body: { clock24: e.target.checked },
        });
        state.h24 = e.target.checked;
      });
      box.querySelector('[data-reduce]').onchange = act(async (e) => {
        await api('/api/settings/appearance', {
          method: 'PUT',
          body: { reduceEffects: e.target.checked },
        });
        document.documentElement.classList.toggle('reduce-effects', e.target.checked);
      });
      box.querySelector('[data-units]').onchange = (e) =>
        globalThis.SentryUnits.set(e.target.value === 'km');
      box.onclick = act(async (e) => {
        const b = e.target.closest('[data-pack]'),
          del = e.target.closest('[data-delete-pack]');
        if (b) await use(b.dataset.pack);
        if (e.target.closest('[data-upload]')) box.querySelector('[data-file]').click();
        if (
          del &&
          (await confirmDialog({
            title: 'Delete this interface?',
            body: '<p>This uploaded pack is deleted from the server. If it is active, everyone gets Original.</p>',
            ok: 'Delete',
            danger: true,
          }))
        ) {
          await confirmPassword();
          await api('/api/ui-packs/' + encodeURIComponent(del.dataset.deletePack), {
            method: 'DELETE',
          });
          ctx.alive() && ctx.render();
        }
      });
      box.querySelector('[data-file]').onchange = act(async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        await confirmPassword();
        const r = await fetch('/api/ui-packs/upload', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
              'X-Requested-With': 'sentry-six-manager',
              'Content-Type': 'application/zip',
              'X-File-Name': encodeURIComponent(file.name),
            },
            body: file,
          }),
          d = await r.json();
        ctx.scope.check();
        if (!r.ok) throw new Error(d.error || 'Upload failed');
        if (
          await confirmDialog({
            title: 'Use it now?',
            body: `<p>${esc(d.pack.name)} is installed. Use it for everyone?</p>`,
            ok: 'Use it',
          })
        )
          await use(d.pack.id);
        else ctx.alive() && ctx.render();
      });
    } else box.innerHTML = '<div class="card">Choose a Settings page.</div>';
  } catch (e) {
    if (!ctx.alive()) return;
    box.innerHTML = `<div class="card">${esc(e.status === 403 ? 'This page is not available to this account.' : e.message)} <a href="#/settings/account">Open Account</a></div>`;
  }
  ctx.scope.signal.addEventListener('abort', () => shared?.destroy?.(), {
    once: true,
  });
  if (!ctx.alive()) shared?.destroy?.();
  return () => {
    summariesStopped = true;
    shared?.destroy?.();
    box.onclick = null;
    box.onchange = null;
  };
}

export const render = ownedRender(renderPage);
