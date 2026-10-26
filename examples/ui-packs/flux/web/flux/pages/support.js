// Support: chat with the Sentry Six team, relayed by this server.
import { esc, api, upload, icon, toast, bytes, confirmDialog } from '../core.js';

const MAX_FILE = 50 * 1024 * 1024;

export default {
  async mount(el) {
    let open = false;
    let since = null;
    let timer = null;
    let alive = true;
    let pollBusy = false;
    el.innerHTML = `<div class="phead"><div><h1>Support</h1><p class="muted small" id="sp-sub">Chat with the Sentry Six team. Messages go through this server to the support service; replies show up here for every signed-in browser.</p></div>
      <div class="phead-actions"><button class="btn" type="button" id="sp-close" hidden>Close ticket</button></div></div>
      <section class="card chat">
        <div class="chat-log" id="sp-log" aria-live="polite"><p class="muted small" id="sp-empty">No open ticket. Your first message opens one.</p></div>
        <form class="chat-form" id="sp-form">
          <label class="sr-only" for="sp-text">Message</label>
          <textarea class="input" id="sp-text" rows="3" maxlength="4000" placeholder="What did you do, what did you expect, what happened?"></textarea>
          <div class="chat-row">
            <label class="check small"><input type="checkbox" id="sp-diag"> Include diagnostics <span class="faint">(version, OS, CPU/GPU, recent warnings; addresses and paths removed)</span></label>
            <label class="btn" for="sp-file">${icon('clip')}Attach</label><input type="file" id="sp-file" class="sr-only" accept="image/*,video/*,.log,.txt,.json">
            <span class="small faint" id="sp-fname"></span>
            <button class="btn primary" type="submit" id="sp-send">Send</button>
          </div>
          <p class="small" id="sp-status" role="status"></p>
        </form>
      </section>`;
    const $ = (s) => el.querySelector(s);
    const log = $('#sp-log');
    const status = (t, bad = false) => { $('#sp-status').textContent = t || ''; $('#sp-status').className = `small ${bad ? 'bad-text' : 'muted'}`; };
    const setOpen = (on) => {
      open = on;
      $('#sp-close').hidden = !on;
      $('#sp-empty').hidden = on || Boolean(log.querySelector('.msg'));
    };
    function msgHtml(m) {
      const me = m.sender === 'user';
      const t = m.timestamp ? new Date(m.timestamp) : null;
      const files = (m.attachments || []).map((a) => {
        if (!a.url) return `<span class="att">${esc(a.name)}</span>`;
        if (String(a.type).startsWith('image/')) return `<a href="${esc(a.url)}" target="_blank" rel="noopener"><img class="att-img" src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy"></a>`;
        if (String(a.type).startsWith('video/')) return `<video class="att-img" src="${esc(a.url)}" controls playsinline preload="metadata"></video>`;
        return `<a class="att" href="${esc(a.url)}" download>${esc(a.name)}</a>`;
      }).join('');
      return `<div class="msg ${me ? 'me' : 'them'}"${m.id ? ` data-id="${esc(m.id)}"` : ''}><div class="msg-who">${me ? 'You' : esc(m.responder || 'Sentry Six support')}${t && !Number.isNaN(t.getTime()) ? ` · <span class="faint">${esc(t.toLocaleString())}</span>` : ''}</div>${m.content ? `<div class="msg-text">${esc(m.content)}</div>` : ''}${files ? `<div class="msg-files">${files}</div>` : ''}${m.hasDiagnostics ? '<div class="faint small">diagnostics attached</div>' : ''}</div>`;
    }
    async function poll() {
      clearTimeout(timer);
      if (!alive) return;
      if (open && !pollBusy && document.visibilityState === 'visible') {
        pollBusy = true;
        try {
          const out = await api(`/api/support/messages${since ? `?since=${encodeURIComponent(since)}` : ''}`, { timeoutMs: 20000 });
          let fresh = false;
          for (const m of out.messages || []) {
            if (m.id && log.querySelector(`[data-id="${CSS.escape(m.id)}"]`)) continue;
            log.insertAdjacentHTML('beforeend', msgHtml(m));
            if (m.id) since = m.id;
            if (m.sender !== 'user' && !m.read) fresh = true;
          }
          if ((out.messages || []).length) log.scrollTop = log.scrollHeight;
          if (fresh) api('/api/support/read', { body: {} }).catch(() => {});
          if (out.closed) { setOpen(false); status('Support closed this ticket. A new message opens a new one.'); } else if (!out.open) setOpen(false);
        } catch (err) {
          status(err.message, true);
        } finally { pollBusy = false; }
      }
      timer = setTimeout(poll, 5000);
    }
    $('#sp-file').onchange = () => {
      const f = $('#sp-file').files[0];
      if (f && f.size > MAX_FILE) { $('#sp-file').value = ''; status(`That file is ${bytes(f.size)}; the limit is ${bytes(MAX_FILE)}.`, true); }
      $('#sp-fname').textContent = $('#sp-file').files[0]?.name || '';
    };
    $('#sp-form').onsubmit = async (e) => {
      e.preventDefault();
      const message = $('#sp-text').value.trim();
      const file = $('#sp-file').files[0] || null;
      if (!message && !file) { status('Write a message or attach a file first.', true); return; }
      const diag = $('#sp-diag').checked;
      $('#sp-send').disabled = true;
      status(file ? 'Uploading…' : 'Sending…');
      try {
        if (file) {
          await upload('/api/support/media', file, { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-Message': encodeURIComponent(message), 'X-Diagnostics': diag ? '1' : '0' });
        } else {
          await api('/api/support/message', { body: { message, includeDiagnostics: diag } });
        }
        $('#sp-text').value = '';
        $('#sp-file').value = '';
        $('#sp-fname').textContent = '';
        $('#sp-diag').checked = false;
        status('Sent.');
        setOpen(true);
        poll();
      } catch (err) {
        status(err.message, true);
      } finally { $('#sp-send').disabled = false; }
    };
    $('#sp-close').onclick = async () => {
      if (!(await confirmDialog({ title: 'Close this support ticket?', body: '<p>You can start a new one any time.</p>', ok: 'Close ticket' }))) return;
      try {
        await api('/api/support/close', { body: {} });
        setOpen(false);
        since = null;
        log.querySelectorAll('.msg').forEach((n) => n.remove());
        $('#sp-empty').hidden = false;
        status('Ticket closed.');
      } catch (err) { status(err.message, true); }
    };
    try {
      const st = await api('/api/support');
      $('#sp-sub').textContent = `Chat with the Sentry Six team through ${st.server || 'the support service'}. Replies show up here for every signed-in browser.`;
      setOpen(Boolean(st.open));
      poll();
    } catch (err) { status(err.message, true); }
    return { unmount() { alive = false; clearTimeout(timer); } };
  }
};
