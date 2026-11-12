import {api,esc,toast,confirmDialog} from '../../core.js';
import {icon} from '../../icons.js';
import {size as bytes,ago as when} from '../../format.js';
export function forms(page,ctx){const {state,render}=ctx,$=id=>page.querySelector('#'+id)||document.getElementById(id),clockPref={h24:state.h24},store={set:(k,v)=>localStorage.setItem('s6:'+k,v)},loadVehicles=async()=>{state.vehicles=(await api('/api/vehicles')).vehicles;};
const fin=n=>typeof n==='number'&&Number.isFinite(n),WEEK=[[1,'Mon'],[2,'Tue'],[3,'Wed'],[4,'Thu'],[5,'Fri'],[6,'Sat'],[0,'Sun']],MAX_RATES=12,priceValue=n=>fin(n)?String(n):'';
  function rateRow(r = {}) {
    const days = new Set(Array.isArray(r.days) ? r.days : [0, 1, 2, 3, 4, 5, 6]);
    return `<div class="rate" data-rate>
      <label class="field">Name<input class="input" data-k="label" maxlength="24" value="${esc(r.label || '')}" placeholder="Off-peak"></label>
      <label class="field">Price per kWh<input class="input" data-k="price" inputmode="decimal" value="${esc(priceValue(r.price))}" placeholder="0.12"></label>
      <label class="field">From<input class="input" type="time" step="60" data-k="from" value="${esc(r.from || '23:00')}"></label>
      <label class="field">To<input class="input" type="time" step="60" data-k="to" value="${esc(r.to || '07:00')}"></label>
      <div class="field rate-days">Days<div class="days-pick">${WEEK.map(([d, name]) => `<label><input type="checkbox" value="${d}"${days.has(d) ? ' checked' : ''}><span>${name}</span></label>`).join('')}</div></div>
      <button type="button" class="btn sm ghost rate-del" data-rate-del aria-label="Remove this rate">Remove</button>
    </div>`;
  }
  function powerCard(p, timezone) {
    const tou = p.mode === 'tou';
    return `<div class="card" data-section="system"><h2>Electricity price</h2>
      <p>For the cost next to energy on the Overview, the Encoder and Jobs. Leave it empty to show energy only.</p>
      <form id="power-form" class="form" style="margin-top:18px" novalidate>
        <div class="field full">Plan<div class="seg" id="power-mode" role="group" aria-label="Plan">
          <button type="button" data-mode="flat" class="${tou ? '' : 'on'}" aria-pressed="${!tou}">One price</button><button type="button" data-mode="tou" class="${tou ? 'on' : ''}" aria-pressed="${tou}">Time of use</button></div></div>
        <label class="field">Currency<input class="input" name="currency" maxlength="3" value="${esc(p.currency || '$')}" placeholder="$"></label>
        <label class="field" data-plan="flat"${tou ? ' hidden' : ''}>Price per kWh<input class="input" name="pricePerKwh" inputmode="decimal" value="${esc(priceValue(p.pricePerKwh))}" placeholder="0.15"></label>
        <label class="field" data-plan="tou"${tou ? '' : ' hidden'}>Other hours (per kWh)<input class="input" name="defaultPrice" inputmode="decimal" value="${esc(priceValue(p.defaultPrice))}" placeholder="0.25"></label>
        <div class="full" data-plan="tou"${tou ? '' : ' hidden'}>
          <p class="muted small">Rates in order: the first one whose days and hours match is used, otherwise the price for other hours. A rate from 23:00 to 07:00 runs over midnight and belongs to the day it starts. Times are the server's${timezone ? ` (${esc(timezone)})` : ''}.</p>
          <div class="rates" id="power-rates">${(p.rates || []).map(rateRow).join('')}</div>
          <button type="button" class="btn sm" id="power-add"${(p.rates || []).length >= MAX_RATES ? ' disabled' : ''}>${icon('plus')} Add a rate</button>
        </div>
        <div class="full form-actions" style="margin-top:0"><button class="btn solid" type="submit">Save price</button></div>
      </form></div>`;
  }
  function wirePower(saved) {
    const form = $('power-form');
    if (!form) return;
    let mode = saved.mode === 'tou' ? 'tou' : 'flat';
    const list = $('power-rates');
    const add = $('power-add');
    const count = () => list.querySelectorAll('[data-rate]').length;
    form.querySelectorAll('#power-mode button').forEach((b) => {
      b.onclick = () => {
        mode = b.dataset.mode;
        form.querySelectorAll('#power-mode button').forEach((x) => {
          x.classList.toggle('on', x === b);
          x.setAttribute('aria-pressed', String(x === b));
        });
        form.querySelectorAll('[data-plan]').forEach((x) => { x.hidden = x.dataset.plan !== mode; });
        if (mode === 'tou' && !count()) list.insertAdjacentHTML('beforeend', rateRow({ label: 'Off-peak' }));
        add.disabled = count() >= MAX_RATES;
      };
    });
    add.onclick = () => {
      if (count() >= MAX_RATES) return;
      list.insertAdjacentHTML('beforeend', rateRow(count() ? { label: 'Peak', from: '16:00', to: '21:00', days: [1, 2, 3, 4, 5] } : { label: 'Off-peak' }));
      add.disabled = count() >= MAX_RATES;
      list.lastElementChild.querySelector('input')?.focus();
    };
    list.onclick = (e) => {
      const del = e.target.closest('[data-rate-del]');
      if (!del) return;
      del.closest('[data-rate]').remove();
      add.disabled = count() >= MAX_RATES;
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const num = (v) => (String(v ?? '').trim() === '' ? null : Number(String(v).replace(',', '.')));
      const rates = [...list.querySelectorAll('[data-rate]')].map((row) => {
        const v = (k) => row.querySelector(`[data-k="${k}"]`).value;
        return { label: v('label').trim(), price: num(v('price')), from: v('from'), to: v('to'), days: [...row.querySelectorAll('.days-pick input:checked')].map((x) => Number(x.value)) };
      });
      const prices = mode === 'tou' ? [num(fd.get('defaultPrice')), ...rates.map((r) => r.price)] : [num(fd.get('pricePerKwh'))];
      if (prices.some(Number.isNaN)) return toast('Enter prices as numbers, like 0.15.', true);
      const body = {
        currency: String(fd.get('currency') || '').trim() || '$', mode,
        pricePerKwh: num(fd.get('pricePerKwh')), defaultPrice: num(fd.get('defaultPrice')),
        // one price keeps the saved plan for later; a plan sends what is on screen
        rates: mode === 'tou' ? rates : (saved.rates || [])
      };
      try {
        const next = await api('/api/settings/power', { method: 'PUT', body });
        state.power = next;
        Object.assign(saved, next);
        toast(mode === 'tou' ? 'Saved. Costs follow the plan from now on.' : body.pricePerKwh === null ? 'Saved. Energy is shown without a cost.' : 'Saved. Costs use this price from now on.');
      } catch (err) {
        toast(err.message, true);
      }
    };
  }
  function updatesCard(u, bl) {
    const cur = u.current || {};
    const tip = bl.buildTip(cur, u.tag);
    const running = `<span${tip ? ` title="${esc(tip)}"` : ''}>${esc(bl.buildText(cur))}${u.tag && u.tag !== 'latest' ? ` (${esc(u.tag)})` : ''}</span>`;
    const how = '<code>docker compose pull &amp;&amp; docker compose up -d</code>';
    if (!u.enabled) {
      return `<div class="card" data-section="updates"><h2>Updates</h2>
        <p>${u.image ? `Checking for updates is turned off (UPDATE_CHECK=off). To update, run ${how} where you set up Sentry Six Manager.` : 'This copy was built from source. To update it, build the image again from the new code.'}</p>
        <dl class="kv" style="margin-top:16px"><dt>Running</dt><dd class="mono">${running}</dd></dl></div>`;
    }
    const l = u.latest;
    const latest = l ? `<span${bl.latestTip(l) ? ` title="${esc(bl.latestTip(l))}"` : ''}>${esc(bl.latestText(l))}</span>` : u.error ? esc(u.error) : 'not checked yet';
    const behind = u.updateAvailable && bl.behindText(u);
    return `<div class="card" data-section="updates"><h2>Updates</h2>
      <p>Updates come as a new image. To install one, run ${how} where you set up Sentry Six Manager. Settings, footage and the Recycle Bin stay as they are.</p>
      <dl class="kv" style="margin-top:16px"><dt>Running</dt><dd class="mono">${running}</dd>
        <dt>Newest</dt><dd${l ? ' class="mono"' : ''}>${latest}${u.checkedAt ? ` <span class="muted">(checked ${when(u.checkedAt)})</span>` : ''}</dd></dl>
      ${u.updateAvailable ? `<div class="note green">${behind ? `${esc(behind)}.` : 'An update is available.'}</div>` : ''}
      <div class="form-actions"><button class="btn" id="upd-check" type="button">Check now</button></div></div>`;
  }
  function securityCard(sec) {
    const tls = sec.tls || {};
    const ca = tls.ca;
    const host = (sec.currentHost || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    const covered = !host || (tls.hostnames || []).map((h) => h.toLowerCase()).includes(host.toLowerCase());
    let body = `<dl class="kv" style="margin-top:16px">
      <dt>This connection</dt><dd>${sec.https ? 'HTTPS (encrypted)' : '<b class="bad-text">not encrypted</b>: others on the network could read your password and the footage. Use https:// or a reverse proxy that does HTTPS.'}</dd>
      <dt>Server process</dt><dd>${sec.runningAsRoot ? 'runs as root (not supervised; fine for development, not for the Docker image)' : 'runs as an unprivileged user; only the supervisor can mount shares'}</dd>`;
    if (sec.tlsMode === 'off') {
      body += '<dt>HTTPS</dt><dd>turned off (TLS_MODE=off): only use this behind a reverse proxy that does HTTPS.</dd></dl>';
    } else if (tls.mode === 'acme') {
      body += `<dt>Certificate</dt><dd>${esc(tls.summary || '')}</dd>
        <dt>Fingerprint</dt><dd class="mono small">${esc(tls.certificate?.fingerprint || '?').replace(/:/g, ':<wbr>')}</dd></dl>`;
    } else if (tls.mode === 'own') {
      body += `<dt>Certificate</dt><dd>your own (TLS_CERT_FILE) · ${esc((tls.certificate?.names || []).join(', '))} · valid until ${esc(tls.certificate?.validTo || '?')}</dd>
        <dt>Fingerprint</dt><dd class="mono small">${esc(tls.certificate?.fingerprint || '?')}</dd></dl>`;
    } else if (tls.error) {
      body += `<dt>Certificate</dt><dd>${esc(tls.error)}</dd></dl>`;
    } else {
      body += `<dt>Certificate fingerprint (SHA-256)</dt><dd class="mono small">${esc(tls.certificate?.fingerprint || '?').replace(/:/g, ':<wbr>')}</dd>
        <dt>Certificate</dt><dd>Sentry Six Manager's own · stays the same until ${esc(tls.certificate?.validTo || '?')}, then renews by itself</dd>
        <dt>Certificate covers</dt><dd>${esc((tls.hostnames || []).join(', '))}</dd>
        <dt>Certificate authority</dt><dd>valid until ${esc(ca?.validTo || '?')} · fingerprint <span class="mono small">${esc(ca?.fingerprint || '?').replace(/:/g, ':<wbr>')}</span></dd></dl>
        <p style="margin-top:14px">Every phone, tablet and computer shows the browser's certificate warning once; continue past it (Advanced, then Proceed / visit this website / Accept the Risk) and the device remembers. To be sure it is this server, compare the certificate fingerprint above with the one in the browser's certificate details or the container log (<code>docker logs sentry-six-manager</code>). If a device that continued before warns again and you changed nothing here, don't continue.</p>
        <p style="margin-top:10px">No warning at all: install the certificate authority on a device instead (download it below and compare its fingerprint before trusting it). It can only vouch for local names and private IP addresses.</p>
        ${covered ? '' : `<div class="note amber">You opened this page as <b>${esc(host)}</b>, which the certificate does not cover, so it warns even on devices with the certificate authority installed. <button class="btn sm" type="button" id="sec-add-host" data-host="${esc(host)}">Add ${esc(host)}</button></div>`}
        <details class="more" style="margin-top:10px"><summary>How to install the certificate authority</summary>
          <ul class="small" style="margin:10px 0 0 18px;display:grid;gap:6px">
            <li><b>iPhone / iPad:</b> open the download in Safari, then Settings &gt; General &gt; VPN &amp; Device Management to install it, and Settings &gt; General &gt; About &gt; Certificate Trust Settings to turn on full trust.</li>
            <li><b>Android:</b> Settings &gt; Security &gt; Encryption &amp; credentials &gt; Install a certificate &gt; CA certificate.</li>
            <li><b>Windows:</b> open the file &gt; Install Certificate &gt; Local Machine &gt; Trusted Root Certification Authorities.</li>
            <li><b>macOS:</b> open it in Keychain Access (System), then set Trust to Always Trust.</li>
            <li><b>Firefox:</b> Settings &gt; Privacy &amp; Security &gt; Certificates &gt; View Certificates &gt; Authorities &gt; Import.</li>
          </ul></details>
        <form id="sec-hosts" class="form" style="margin-top:16px">
          <label class="field full">Extra names and addresses for the certificate<input class="input" name="hostnames" value="${esc((tls.editable || []).join(', '))}" placeholder="192.168.1.20, nas.local"></label>
          <p class="muted small full">The IP addresses or names you type in the browser to reach this server; only devices with the certificate authority installed need them. Saving makes a new certificate, so devices that continued past the warning see it once more. Names from TLS_HOSTNAMES: ${esc((tls.fromEnv || []).join(', ') || 'none')}.</p>
          <div class="full form-actions" style="margin-top:0"><a class="btn" href="/api/security/ca.crt" download>Download certificate authority</a><button class="btn solid" type="submit">Save names</button></div>
        </form>`;
    }
    // sign-in protection for a server open to the internet (web/accessSettings.js, the same in every interface)
    body += `<h3 style="margin:26px 0 4px">Sign-in protection</h3><p class="muted small" style="margin:0 0 14px">Rules for a server that is reachable from the internet. They decide by the address each request comes from; the home network is defined at the bottom.</p><div id="sec-access"></div>`;
    return `<div class="card" data-section="security"><h2>Security</h2>${body}</div>`;
  }
  function wireSecurity(sec) {
    const save = async (names) => {
      const ok = await confirmDialog({
        title: 'Make a new certificate?',
        body: '<p>The certificate will cover the new names. Every phone, tablet and computer that continued past the browser\'s warning before will see it once more; devices with the certificate authority installed won\'t.</p>',
        ok: 'Save names'
      });
      if (!ok) return;
      try {
        const out = await api('/api/security/hostnames', { method: 'PUT', body: { hostnames: names } });
        toast(`${out.caReplaced ? 'Saved. The certificate authority was replaced: install the new one on your devices.' : 'Saved. The certificate now covers those names.'} Reloading the page for the new certificate…`);
        // the browser has to pick up the new certificate; a page that clicked
        // past a warning would otherwise fail every request from now on
        setTimeout(() => location.reload(), 2500);
      } catch (err) {
        toast(err.message, true);
      }
    };
    const form = $('sec-hosts');
    if (form) {
      form.onsubmit = (e) => {
        e.preventDefault();
        save(String(new FormData(form).get('hostnames') || '').split(/[\s,]+/).filter(Boolean));
      };
    }
    const add = $('sec-add-host');
    if (add) add.onclick = () => save([...(sec.tls?.editable || []), add.dataset.host]);
    const box = $('sec-access');
    if (box) {
      import('/web/accessSettings.js').then((m) => {
        if ($('sec-access') === box) m.createAccessSettings(box, { cls: { btn: 'btn sm', primary: 'btn sm solid', input: 'input' }, h24: () => clockPref.h24 });
      }).catch(() => { box.textContent = 'Sign-in protection could not load. Reload the page.'; });
    }
  }
  function vehicleForm(v) {
    const versions = state.system?.smbVersions || { '3.1.1': 'SMB 3.1.1 (recommended)', '3.02': 'SMB 3.02', '3.0': 'SMB 3.0', 3: 'SMB 3.0 or newer' };
    const s = v?.source || { type: 'smb', version: state.system?.smbDefaultVersion || '3.1.1', encrypt: true };
    return `<form id="veh" class="form" style="margin-top:22px;padding-top:22px;border-top:1px solid var(--border)">
      <h3 class="full">${v ? `Edit ${esc(v.name)}` : 'Add a vehicle'}</h3>
      <label class="field">Name<input class="input" name="name" required value="${esc(v?.name || '')}" placeholder="Daily Driver"></label>
      <label class="field">Time zone<input class="input" name="timezone" value="${esc(v?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone)}" placeholder="America/Chicago"></label>
      <div data-car-slot style="display:contents"></div>
      <div class="field full">Footage source<div class="seg" id="src-type"><button type="button" data-type="smb" class="${s.type !== 'path' ? 'on' : ''}">SMB share</button><button type="button" data-type="path" class="${s.type === 'path' ? 'on' : ''}">Folder in the container</button></div></div>
      <div class="full form" data-src="smb"${s.type === 'path' ? ' hidden' : ''}>
        <label class="field full">Share<input class="input" name="share" value="${esc(s.share || '')}" placeholder="//192.168.1.50/TeslaCam"></label>
        <label class="field">User name<input class="input" name="username" value="${esc(s.username || '')}" autocomplete="off"></label>
        <label class="field">Password<input class="input" name="password" type="password" placeholder="${s.passwordSet ? 'saved — leave empty to keep' : ''}" autocomplete="new-password"></label>
        <label class="field">Domain (optional)<input class="input" name="domain" value="${esc(s.domain || '')}"></label>
        <label class="field">SMB version<select class="input" name="version">${Object.entries(versions).map(([x, label]) => `<option value="${esc(x)}"${String(s.version || '3.1.1') === x ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
        <label class="field">Port (optional)<input class="input" name="port" inputmode="numeric" value="${esc(s.port || '')}" placeholder="445"></label>
        <label class="check full"><input type="checkbox" name="encrypt"${s.encrypt === false ? '' : ' checked'}> Encrypt the connection (recommended). Without it the connection is still signed, so nobody can change the footage, but others on the network could watch it.</label>
        <div class="full smb-test"><button class="btn" type="button" id="smb-test">Test connection</button><p class="small" id="smb-test-result" role="status" aria-live="polite"></p></div>
        <p class="muted small full">Only SMB 3 is allowed and every connection is signed, so a man in the middle cannot read or change footage, or pose as your NAS. Files on the share can never run as programs inside the container. Use a dedicated NAS account with access to this share only.</p>
      </div>
      <div class="full" data-src="path"${s.type === 'path' ? '' : ' hidden'}>
        <label class="field">Folder<input class="input" name="path" value="${esc(s.path || '')}" placeholder="/footage/weekend-car"></label>
        <p class="muted small" style="margin-top:8px">A folder you mounted into the container yourself (bind mount or Docker CIFS volume).</p>
      </div>
      <div class="full form-actions">${v ? '<button class="btn danger" type="button" id="veh-del">Remove vehicle</button><button class="btn" type="button" id="veh-saved">Reset space saved</button>' : ''}<a class="btn" href="#/settings">Cancel</a><button class="btn solid" type="submit">${v ? 'Save' : 'Add vehicle'}</button></div>
    </form>`;
  }
  function wireSettings(editing) {
    const veh = $('veh');
    if (veh) {
      // the car model and year (web/carModelField.js, shared with the other interfaces)
      let carField = null;
      const slot = veh.querySelector('[data-car-slot]');
      if (slot) {
        import('/web/carModelField.js').then((m) => {
          if (!slot.isConnected) return;
          carField = m;
          slot.innerHTML = m.carModelFields(state.vehicles.find((x) => x.id === editing), { hint: 'muted small full' });
          m.wireCarModel(veh);
        }).catch(() => {});
      }
      let type = veh.querySelector('#src-type .on')?.dataset.type || 'smb';
      veh.querySelectorAll('#src-type button').forEach((b) => {
        b.onclick = () => {
          type = b.dataset.type;
          veh.querySelectorAll('#src-type button').forEach((x) => x.classList.toggle('on', x === b));
          veh.querySelectorAll('[data-src]').forEach((x) => { x.hidden = x.dataset.src !== type; });
        };
      });
      // Test connection: the details as typed, nothing saved
      const testBtn = $('smb-test');
      if (testBtn) {
        testBtn.onclick = async () => {
          const fd = new FormData(veh);
          const out = $('smb-test-result');
          testBtn.disabled = true;
          out.className = 'small muted';
          out.textContent = 'Connecting to the NAS…';
          try {
            const r = await api('/api/vehicles/test-smb', { body: {
              vehicleId: editing !== 'new' ? editing : null,
              source: { type: 'smb', share: fd.get('share'), username: fd.get('username'), password: fd.get('password') || undefined, domain: fd.get('domain'), version: fd.get('version'), encrypt: fd.get('encrypt') === 'on', port: fd.get('port') || null }
            } });
            if (!out.isConnected) return;
            if (r.ok) {
              out.className = 'small smb-ok';
              out.textContent = `Connected: the user name and password work. ${r.footage ? `Tesla footage found${r.footage === '.' ? '' : ` in ${r.footage}`}.` : 'No TeslaCam folder found yet (empty share, or the footage is deeper than 3 folders).'} ${r.writable ? '' : `${r.writeProblem || 'Read-only for this account: the Recycle Bin, Protect and replacing originals need write access.'}`}`.trim();
            } else {
              out.className = 'small smb-bad';
              out.textContent = `${r.stage === 'details' ? '' : 'Could not connect: '}${r.error}${r.hint ? ` ${r.hint}` : ''}`;
            }
          } catch (err) {
            if (out.isConnected) {
              out.className = 'small smb-bad';
              out.textContent = err.message;
            }
          } finally {
            testBtn.disabled = false;
          }
        };
      }
      veh.onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(veh);
        const body = { name: fd.get('name'), timezone: fd.get('timezone'), source: type === 'path'
          ? { type: 'path', path: fd.get('path') }
          : { type: 'smb', share: fd.get('share'), username: fd.get('username'), password: fd.get('password') || undefined, domain: fd.get('domain'), version: fd.get('version'), encrypt: fd.get('encrypt') === 'on', port: fd.get('port') || null } };
        if (carField) body.car = carField.readCarModel(veh);
        // only send the source when it changed, so a rename needs no password
        if (editing !== 'new') {
          const was = state.vehicles.find((x) => x.id === editing)?.source || {};
          const same = type === was.type && (type === 'path'
            ? body.source.path === was.path
            : ['share', 'username', 'domain', 'version'].every((k) => String(body.source[k] ?? '') === String(was[k] ?? ''))
              && body.source.encrypt === (was.encrypt !== false) && String(body.source.port ?? '') === String(was.port ?? '') && !body.source.password);
          if (same) delete body.source;
        }
        try {
          const saved = editing === 'new' ? await api('/api/vehicles', { body }) : await api(`/api/vehicles/${encodeURIComponent(editing)}`, { method: 'PUT', body });
          state.vehicleId = saved.id;
          store.set('vehicle', saved.id);
          toast('Saved. Connecting to the footage…');
          await loadVehicles();
          location.hash = '#/settings';
        } catch (err) {
          toast(err.message, true);
        }
      };
      if ($('veh-saved')) {
        $('veh-saved').onclick = async () => {
          if (!(await confirmDialog({ title: 'Reset space saved?', body: '<p>The total of space saved by conversions starts again from zero for this vehicle, for example after its footage was deleted. No footage or conversion is touched.</p>', ok: 'Reset', danger: true }))) return;
          await api(`/api/vehicles/${encodeURIComponent(editing)}/saved`, { method: 'DELETE' }).then(() => toast('Space saved starts again from zero.'), (err) => toast(err.message, true));
          await loadVehicles();
        };
      }
      if ($('veh-del')) {
        $('veh-del').onclick = async () => {
          if (!(await confirmDialog({ title: 'Remove this vehicle?', body: '<p>Sentry Six Manager forgets the vehicle and unmounts its share. No footage is deleted.</p>', ok: 'Remove', danger: true }))) return;
          await api(`/api/vehicles/${encodeURIComponent(editing)}`, { method: 'DELETE' }).catch((err) => toast(err.message, true));
          await loadVehicles();
          location.hash = '#/settings';
        };
      }
    }
    const check = $('upd-check');
    if (check) {
      check.onclick = async () => {
        check.disabled = true;
        try {
          const out = await api('/api/updates/check', { body: {} });
          toast(out.error || (out.updateAvailable ? 'An update is available.' : 'This is the latest version.'), Boolean(out.error));
        } catch (err) {
          toast(err.message, true);
        }
        render();
      };
    }
    if ($('pw')) $('pw').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('/api/auth/password', { body: { current: fd.get('current'), next: fd.get('next') } });
        toast('Password changed.');
        e.target.reset();
      } catch (err) {
        toast(err.message, true);
      }
    };
  }
return {powerCard,wirePower,updatesCard,securityCard,wireSecurity,vehicleForm,wireSettings};}
