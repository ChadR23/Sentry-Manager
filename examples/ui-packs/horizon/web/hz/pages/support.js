// Support: chat with the Sentry Six team, relayed by this server.
import { h, ico, api, send, toast, ask, size, panelHead } from '../core.js';

const MAX = 50 * 1024 * 1024;

export default {
  async mount(el, { status }) {
    let open = false;
    let after = null;
    let timer = 0;
    let alive = true;
    let polling = false;
    el.innerHTML = `<section class="ptitle hud"><div><h1 class="chrome">Support</h1><p id="s-sub">Chat with the Sentry Six team. Messages go through this server; replies show up here in every signed-in browser.</p></div>
        <div class="pacts"><button class="btn" type="button" id="s-close" hidden>${ico('check')}Close ticket</button></div></section>
      <section class="panel hud cyan chat">
        ${panelHead(`${ico('chat')}Radio channel`)}
        <div class="chatlog" id="s-log" aria-live="polite"><p class="dim small" id="s-empty">No open ticket. Your first message opens one.</p></div>
        <form class="chatform" id="s-form">
          <label class="sr-only" for="s-text">Message</label>
          <textarea class="in" id="s-text" rows="3" maxlength="4000" placeholder="What did you do, what did you expect, and what happened?"></textarea>
          <div class="row">
            <label class="chk"><input type="checkbox" id="s-diag"> Include diagnostics <span class="small faint">(version, OS, CPU/GPU, recent warnings; addresses and paths removed)</span></label>
          </div>
          <div class="row">
            <label class="btn" for="s-file">${ico('clip')}Attach a file</label><input type="file" id="s-file" class="sr-only" accept="image/*,video/*,.log,.txt,.json">
            <span class="small faint grow ell" id="s-fname"></span>
            <button class="btn go" type="submit" id="s-send">Send</button>
          </div>
          <p class="small" id="s-status" role="status"></p>
        </form>
      </section>`;
    const $ = (s) => el.querySelector(s);
    const log = $('#s-log');
    const say = (t, bad = false) => { $('#s-status').textContent = t || ''; $('#s-status').className = `small ${bad ? 'badtx' : 'dim'}`; };
    const setOpen = (o) => {
      open = o;
      $('#s-close').hidden = !o;
      $('#s-empty').hidden = o || Boolean(log.querySelector('.msg'));
      status(o ? 'ticket open' : 'no open ticket');
    };
    function msg(m) {
      const me = m.sender === 'user';
      const t = m.timestamp ? new Date(m.timestamp) : null;
      const files = (m.attachments || []).map((a) => {
        if (!a.url) return `<span class="att">${h(a.name)}</span>`;
        if (String(a.type).startsWith('image/')) return `<a href="${h(a.url)}" target="_blank" rel="noopener"><img class="att-img" src="${h(a.url)}" alt="${h(a.name)}" loading="lazy"></a>`;
        if (String(a.type).startsWith('video/')) return `<video class="att-img" src="${h(a.url)}" controls playsinline preload="metadata"></video>`;
        return `<a class="btn sm" href="${h(a.url)}" download>${ico('download')}${h(a.name)}</a>`;
      }).join('');
      return `<div class="msg ${me ? 'me' : 'them'}"${m.id ? ` data-id="${h(m.id)}"` : ''}><div class="msg-who small">${me ? 'You' : h(m.responder || 'Sentry Six support')}${t && !Number.isNaN(t.getTime()) ? ` · <span class="faint">${h(t.toLocaleString())}</span>` : ''}</div>${m.content ? `<div class="msg-t">${h(m.content)}</div>` : ''}${files ? `<div class="msg-f">${files}</div>` : ''}${m.hasDiagnostics ? '<div class="tiny faint">diagnostics attached</div>' : ''}</div>`;
    }
    async function poll() {
      clearTimeout(timer);
      if (!alive) return;
      if (open && !polling && document.visibilityState === 'visible') {
        polling = true;
        try {
          const out = await api(`/api/support/messages${after ? `?since=${encodeURIComponent(after)}` : ''}`, { timeout: 20000 });
          let fresh = false;
          for (const m of out.messages || []) {
            if (m.id && log.querySelector(`[data-id="${CSS.escape(m.id)}"]`)) continue;
            log.insertAdjacentHTML('beforeend', msg(m));
            if (m.id) after = m.id;
            if (m.sender !== 'user' && !m.read) fresh = true;
          }
          if ((out.messages || []).length) log.scrollTop = log.scrollHeight;
          if (fresh) api('/api/support/read', { body: {} }).catch(() => {});
          if (out.closed) { setOpen(false); say('Support closed this ticket. A new message opens a new one.'); } else if (!out.open) setOpen(false);
        } catch (err) { say(err.message, true); } finally { polling = false; }
      }
      timer = setTimeout(poll, 5000);
    }
    $('#s-file').onchange = () => {
      const f = $('#s-file').files[0];
      if (f && f.size > MAX) { $('#s-file').value = ''; say(`That file is ${size(f.size)}; the limit is ${size(MAX)}.`, true); }
      $('#s-fname').textContent = $('#s-file').files[0]?.name || '';
    };
    $('#s-form').onsubmit = async (e) => {
      e.preventDefault();
      const message = $('#s-text').value.trim();
      const file = $('#s-file').files[0] || null;
      if (!message && !file) { say('Write a message or attach a file first.', true); return; }
      const diag = $('#s-diag').checked;
      $('#s-send').disabled = true;
      say(file ? 'Uploading…' : 'Sending…');
      try {
        if (file) await send('/api/support/media', file, { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-Message': encodeURIComponent(message), 'X-Diagnostics': diag ? '1' : '0' });
        else await api('/api/support/message', { body: { message, includeDiagnostics: diag } });
        $('#s-text').value = '';
        $('#s-file').value = '';
        $('#s-fname').textContent = '';
        $('#s-diag').checked = false;
        say('Sent.');
        setOpen(true);
        poll();
      } catch (err) { say(err.message, true); } finally { $('#s-send').disabled = false; }
    };
    $('#s-close').onclick = async () => {
      if (!(await ask({ title: 'Close this support ticket?', body: '<p>You can start a new one any time.</p>', yes: 'Close ticket' }))) return;
      try {
        await api('/api/support/close', { body: {} });
        setOpen(false);
        after = null;
        log.querySelectorAll('.msg').forEach((n) => n.remove());
        $('#s-empty').hidden = false;
        say('Ticket closed.');
        toast('Ticket closed.');
      } catch (err) { say(err.message, true); }
    };
    try {
      const st = await api('/api/support');
      $('#s-sub').textContent = `Chat with the Sentry Six team through ${st.server || 'the support service'}. Replies show up here in every signed-in browser.`;
      setOpen(Boolean(st.open));
      poll();
    } catch (err) { say(err.message, true); }
    return { unmount() { alive = false; clearTimeout(timer); } };
  }
};
