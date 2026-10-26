// Support: a chat with the Sentry Six team, relayed by this server. Messages,
// a file attachment (raw upload with its name and message in headers),
// optional diagnostics, read receipts and closing the ticket.

import { $, esc, icon, api, upload, bytes, toast, confirmDialog } from '../core.js';

const MAX_FILE = 50 * 1024 * 1024;

function bubble(m) {
  const me = m.sender === 'user';
  const t = m.timestamp ? new Date(m.timestamp) : null;
  const time = t && !Number.isNaN(t.getTime()) ? t.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const files = (m.attachments || []).map((a) => {
    const type = String(a.type || '');
    if (!a.url) return `<span class="chip">${esc(a.name)}</span>`;
    if (type.startsWith('image/')) return `<a class="att-img" href="${esc(a.url)}" data-lightbox aria-label="Open ${esc(a.name)}"><img src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy"></a>`;
    if (type.startsWith('video/')) return `<video src="${esc(a.url)}" controls playsinline preload="metadata"></video>`;
    return `<a class="btn sm" href="${esc(a.url)}" download>${icon('download', 'ico-sm')} ${esc(a.name)}</a>`;
  }).join('');
  return `<div class="bubble ${me ? 'me' : 'them'}"${m.id ? ` data-mid="${esc(m.id)}"` : ''}><div class="who">${me ? 'You' : esc(m.responder || 'Sentry Six support')}${time ? ` · ${esc(time)}` : ''}</div>
    ${m.content ? `<div class="text">${esc(m.content)}</div>` : ''}${files ? `<div class="att">${files}</div>` : ''}${m.hasDiagnostics ? '<div class="muted tiny">Diagnostics attached</div>' : ''}</div>`;
}

export default {
  title: 'Support',
  kicker: 'Ground control',
  icon: 'chat',
  async mount(ctx) {
    const { body, actions } = ctx;
    let dead = false;
    let open = false;
    let since = null;
    let timer = 0;
    let busy = false;
    actions.innerHTML = `<button class="btn" type="button" id="s-close" hidden>${icon('x')} Close ticket</button>`;
    body.innerHTML = `<div class="support-grid">
      <section class="panel"><div class="panel-head"><h2>Chat with the Sentry Six team</h2><span class="chip" id="s-state">no open ticket</span></div>
        <div class="chat" id="chat" aria-live="polite" aria-label="Messages"><p class="muted small" id="chat-empty">No open ticket. Your first message opens one.</p></div>
        <form class="composer" id="s-form" novalidate>
          <label class="field">Message<textarea class="input" id="s-text" rows="3" maxlength="4000" placeholder="What did you do, what did you expect, what happened?"></textarea></label>
          <label class="check"><input type="checkbox" id="s-diag"> Include diagnostics <span class="muted small">(version, OS, CPU/GPU, recent warnings; addresses and footage paths removed)</span></label>
          <div class="row"><label class="btn file-pick">${icon('clip')} Attach a file<input type="file" id="s-file" accept="image/*,video/*,.log,.txt,.json" aria-label="Attach a file"></label><span class="muted small" id="s-fname"></span><span class="spacer"></span><button class="btn primary" type="submit" id="s-send">${icon('send')} Send</button></div>
          <p class="muted small" id="s-status" role="status"></p>
        </form></section>
      <section class="panel"><h2>Before you write</h2><ul class="list small" style="margin-top:12px">
        <li><span class="dot ok" style="margin-top:7px"></span><div>Messages go to the Sentry Six support server and replies show up here, for everyone who signs in to this server.</div></li>
        <li><span class="dot ok" style="margin-top:7px"></span><div>A screenshot or the log (Sky → Logs → Download) helps a lot. Files up to ${bytes(MAX_FILE)}.</div></li>
        <li><span class="dot ok" style="margin-top:7px"></span><div>Diagnostics never include passwords, addresses or footage paths.</div></li></ul></section></div>`;
    const chat = $('#chat', body);
    const status = (m, bad = false) => {
      const el = $('#s-status', body);
      el.textContent = m || '';
      el.style.color = bad ? 'var(--bad)' : '';
    };
    const setOpen = (v) => {
      open = v;
      $('#s-close', actions).hidden = !v;
      $('#s-state', body).textContent = v ? 'ticket open' : 'no open ticket';
      $('#s-state', body).className = `chip${v ? ' green' : ''}`;
      $('#chat-empty', body).hidden = v || Boolean(chat.querySelector('.bubble'));
    };

    async function poll() {
      clearTimeout(timer);
      if (dead) return;
      if (open && !document.hidden && !busy) {
        busy = true;
        try {
          const out = await api(`/api/support/messages${since ? `?since=${encodeURIComponent(since)}` : ''}`, { timeoutMs: 20000 });
          if (dead) return;
          let fresh = false;
          for (const m of out.messages || []) {
            if (m.id && chat.querySelector(`[data-mid="${CSS.escape(m.id)}"]`)) continue;
            chat.insertAdjacentHTML('beforeend', bubble(m));
            if (m.id) since = m.id;
            if (m.sender !== 'user' && !m.read) fresh = true;
          }
          if ((out.messages || []).length) chat.scrollTop = chat.scrollHeight;
          $('#chat-empty', body).hidden = Boolean(chat.querySelector('.bubble')) || open;
          if (fresh) api('/api/support/read', { body: {} }).catch(() => {});
          if (out.closed) { setOpen(false); status('Support closed this ticket. A new message opens a new one.'); } else if (out.open === false) setOpen(false);
        } catch (err) {
          status(err.message, true);
        } finally {
          busy = false;
        }
      }
      timer = setTimeout(poll, 5000);
    }

    $('#s-file', body).addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f && f.size > MAX_FILE) {
        e.target.value = '';
        status(`That file is ${bytes(f.size)}; the limit is ${bytes(MAX_FILE)}.`, true);
      }
      $('#s-fname', body).textContent = e.target.files[0]?.name || '';
    });
    $('#s-form', body).addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = $('#s-text', body).value.trim();
      const file = $('#s-file', body).files[0] || null;
      if (!text && !file) { status('Write a message or attach a file first.', true); return; }
      const btn = $('#s-send', body);
      btn.disabled = true;
      status(file ? 'Uploading…' : 'Sending…');
      try {
        const diag = $('#s-diag', body).checked;
        if (file) {
          await upload('/api/support/media', file, {
            'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name),
            'X-Message': encodeURIComponent(text), 'X-Diagnostics': diag ? '1' : '0'
          });
        } else {
          await api('/api/support/message', { body: { message: text, includeDiagnostics: diag } });
        }
        if (dead) return;
        $('#s-text', body).value = '';
        $('#s-file', body).value = '';
        $('#s-fname', body).textContent = '';
        $('#s-diag', body).checked = false;
        status('Sent.');
        setOpen(true);
        poll();
      } catch (err) {
        status(err.message, true);
      } finally {
        btn.disabled = false;
      }
    });
    $('#s-close', actions).addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Close this ticket?', body: '<p>You can start a new one any time with a new message.</p>', ok: 'Close ticket' }))) return;
      try {
        await api('/api/support/close', { body: {} });
        setOpen(false);
        since = null;
        chat.querySelectorAll('.bubble').forEach((n) => n.remove());
        $('#chat-empty', body).hidden = false;
        status('Ticket closed.');
      } catch (err) { status(err.message, true); }
    });
    chat.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-lightbox]');
      if (!a) return;
      e.preventDefault();
      const box = $('#lightbox');
      $('#lightbox-img').src = a.getAttribute('href');
      $('#lightbox-img').alt = a.querySelector('img')?.alt || '';
      $('#lightbox-name').textContent = a.querySelector('img')?.alt || '';
      $('#lightbox-save').href = a.getAttribute('href');
      box.showModal();
    });

    try {
      const st = await api('/api/support');
      setOpen(Boolean(st.open));
    } catch (err) { status(err.message, true); }
    poll();
    return {
      destroy() { dead = true; clearTimeout(timer); }
    };
  }
};
