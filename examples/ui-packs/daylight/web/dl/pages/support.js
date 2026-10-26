// Help & support: a chat with the Sentry Six team, relayed by this server.

import { api, upload, esc, icon, bytes, confirmDialog, toast, fail, modal } from '../core.js';

const MAX_FILE = 50 * 1024 * 1024;

function message(m) {
  const me = m.sender === 'user';
  const t = m.timestamp ? new Date(m.timestamp) : null;
  const time = t && !Number.isNaN(t.getTime()) ? t.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const files = (m.attachments || []).map((a) => {
    if (!a.url) return `<span class="chip">${esc(a.name)}</span>`;
    if (String(a.type).startsWith('image/')) return `<button type="button" class="thumb" data-picture="${esc(a.url)}" data-name="${esc(a.name)}" style="border:0;padding:0;border-radius:10px;margin-top:8px;max-width:260px"><img class="thumb-img" src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy"></button>`;
    if (String(a.type).startsWith('video/')) return `<video src="${esc(a.url)}" controls playsinline preload="metadata"></video>`;
    return `<a class="btn btn-sm" href="${esc(a.url)}" download>${icon('download')} ${esc(a.name)}</a>`;
  }).join('');
  return `<div class="bubble ${me ? 'me' : 'them'}"${m.id ? ` data-id="${esc(m.id)}"` : ''}><div class="who">${me ? 'You' : esc(m.responder || 'Sentry Six support')}${time ? ` · ${esc(time)}` : ''}</div>
    ${m.content ? `<div>${esc(m.content).replace(/\n/g, '<br>')}</div>` : ''}${files}${m.hasDiagnostics ? '<div class="tiny" style="opacity:.8;margin-top:4px">Diagnostics attached</div>' : ''}</div>`;
}

export async function render(ctx) {
  const { view } = ctx;
  view.innerHTML = `<div class="page" style="max-width:860px">
    <div class="page-head"><div><h1>Help &amp; support</h1><p class="lede">Ask the Sentry Six team. Messages go to the Sentry Six support server (api.sentry-six.com) and replies show up here, on every device you sign in on.</p></div>
      <div class="head-actions"><button class="btn btn-sm" type="button" id="close" hidden>Close conversation</button></div></div>
    <div class="card">
      <div class="chat" id="chat" aria-live="polite"><p class="muted" id="chat-empty">No conversation yet. Your first message starts one.</p></div>
      <form class="composer" id="form">
        <label class="field"><span class="sr-only">Message</span><textarea class="input" id="text" rows="3" maxlength="4000" placeholder="What happened, and what did you expect?"></textarea></label>
        <label class="check"><input type="checkbox" id="diag"> <span>Include diagnostics <span class="muted small">(version, system, graphics card, recent warnings; addresses and footage paths removed)</span></span></label>
        <div class="row"><input type="file" id="file" hidden accept="image/*,video/*,.log,.txt,.json">
          <button class="btn btn-sm" type="button" id="attach">${icon('attach')} Attach a file</button><span class="muted small" id="file-name"></span>
          <span class="spacer"></span><button class="btn btn-primary" type="submit" id="send">${icon('send')} Send</button></div>
        <p class="small" id="status" role="status"></p>
      </form></div></div>`;
  const $ = (s) => view.querySelector(s);
  const chat = $('#chat');
  let open = false;
  let since = null;
  let polling = false;
  const status = (msg, bad = false) => { $('#status').textContent = msg || ''; $('#status').style.color = bad ? 'var(--bad)' : ''; };
  const setOpen = (v) => {
    open = v;
    $('#close').hidden = !v;
    $('#chat-empty').hidden = v || chat.querySelector('.bubble') !== null;
  };
  const poll = async () => {
    if (!open || polling || !ctx.alive()) return;
    polling = true;
    try {
      const out = await api(`/api/support/messages${since ? `?since=${encodeURIComponent(since)}` : ''}`, { timeoutMs: 20000 });
      let fresh = false;
      for (const m of out.messages || []) {
        if (m.id && chat.querySelector(`[data-id="${CSS.escape(m.id)}"]`)) continue;
        chat.insertAdjacentHTML('beforeend', message(m));
        if (m.id) since = m.id;
        if (m.sender !== 'user' && !m.read) fresh = true;
      }
      if ((out.messages || []).length) chat.scrollTop = chat.scrollHeight;
      if (fresh) api('/api/support/read', { method: 'POST' }).catch(() => {});
      if (out.closed) { setOpen(false); status('Support closed this conversation. A new message starts a new one.'); } else if (!out.open) setOpen(false);
    } catch (err) {
      status(err.message, true);
    } finally {
      polling = false;
    }
  };
  chat.addEventListener('click', (e) => {
    const b = e.target.closest('[data-picture]');
    if (!b) return;
    modal({ title: b.dataset.name || 'Picture', wide: true, body: `<img src="${esc(b.dataset.picture)}" alt="${esc(b.dataset.name || '')}" style="max-width:100%;border-radius:12px">`, buttons: [{ label: 'Close', value: 'ok', kind: 'primary' }] });
  });
  const fileInput = $('#file');
  $('#attach').onclick = () => fileInput.click();
  fileInput.onchange = () => {
    const f = fileInput.files[0];
    if (f && f.size > MAX_FILE) { fileInput.value = ''; status(`That file is ${bytes(f.size)}; the limit is ${bytes(MAX_FILE)}.`, true); }
    $('#file-name').textContent = fileInput.files[0]?.name || '';
  };
  $('#form').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('#text').value.trim();
    const file = fileInput.files[0] || null;
    if (!text && !file) return status('Write a message or attach a file first.', true);
    const diag = $('#diag').checked;
    $('#send').disabled = true;
    status(file ? 'Uploading…' : 'Sending…');
    try {
      if (file) {
        await upload('/api/support/media', file, { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-Message': encodeURIComponent(text), 'X-Diagnostics': diag ? '1' : '0' });
      } else {
        await api('/api/support/message', { body: { message: text, includeDiagnostics: diag } });
      }
      $('#text').value = '';
      fileInput.value = '';
      $('#file-name').textContent = '';
      $('#diag').checked = false;
      status('Sent. We’ll show the reply here.');
      setOpen(true);
      poll();
    } catch (err) {
      status(err.message, true);
    } finally {
      $('#send').disabled = false;
    }
    return undefined;
  };
  $('#close').onclick = async () => {
    if (!(await confirmDialog({ title: 'Close this conversation?', body: '<p>You can start a new one any time.</p>', ok: 'Close it' }))) return;
    try {
      await api('/api/support/close', { method: 'POST' });
      setOpen(false);
      since = null;
      chat.querySelectorAll('.bubble').forEach((n) => n.remove());
      $('#chat-empty').hidden = false;
      toast('Conversation closed.');
    } catch (err) { fail(err); }
  };
  try {
    const st = await api('/api/support');
    setOpen(Boolean(st.open));
    poll();
  } catch (err) { status(err.message, true); }
  ctx.every(5000, poll);
}
