export const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export async function api(path, { method, body, ...rest } = {}, retried = false) {
  const res = await fetch(path, {
    ...rest,
    method: method || (body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'sentry-six-manager',
      ...rest.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth/')) location.href = '/login';
  if (res.status === 403 && data.code === 'CONFIRM_PASSWORD' && !retried) {
    await confirmPassword();
    return api(path, { method, body, ...rest }, true);
  }
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}
export function toast(text, bad = false) {
  const el = document.createElement('div');
  el.className = 'toast ' + (bad ? 'bad' : '');
  el.textContent = text;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 6000);
}
export function confirmDialog({ title, body, ok = 'Confirm', danger = false, onConfirm }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2><div>${body}</div><footer><button value="cancel" type="button">Cancel</button><button value="ok" class="${danger ? 'danger' : 'primary'}">${esc(ok)}</button></footer></form>`;
    document.body.append(dlg);
    dlg.querySelector('[value=cancel]').onclick = () => dlg.close('cancel');
    dlg.onclose = () => {
      const yes = dlg.returnValue === 'ok';
      if (yes) onConfirm?.(dlg.querySelector('form'));
      dlg.remove();
      resolve(yes);
    };
    dlg.showModal();
  });
}
export async function confirmPassword() {
  let password = '';
  const yes = await new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.innerHTML =
      '<form method="dialog"><h2>Confirm with your password</h2><label>Password<input type="password" autocomplete="current-password" name="password" required></label><footer><button type="button">Cancel</button><button value="ok" class="primary">Confirm</button></footer></form>';
    document.body.append(dlg);
    dlg.querySelector('button').onclick = () => dlg.close();
    dlg.querySelector('form').onsubmit = () => {
      password = dlg.querySelector('input').value;
      dlg.returnValue = 'ok';
    };
    dlg.onclose = () => {
      resolve(dlg.returnValue === 'ok');
      dlg.remove();
    };
    dlg.showModal();
  });
  if (!yes) throw new Error('Not changed: password not confirmed.');
  await api('/api/auth/confirm', { body: { password } }, true);
}
export function sheet(el, { anchor, popover = false } = {}) {
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  const close = document.createElement('button');
  close.textContent = 'Close';
  close.onclick = () => dlg.close();
  dlg.append(close, el);
  document.body.append(dlg);
  dlg.addEventListener('close', () => {
    dlg.remove();
    anchor?.focus();
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
  dlg.showModal();
  if (popover && anchor && matchMedia('(min-width:761px)').matches) {
    const rect = anchor.getBoundingClientRect();
    Object.assign(dlg.style, {
      position: 'fixed',
      margin: '0',
      left: Math.max(12, Math.min(rect.left, innerWidth - dlg.offsetWidth - 12)) + 'px',
      top: Math.max(12, Math.min(rect.bottom + 8, innerHeight - dlg.offsetHeight - 12)) + 'px',
    });
  }
  return () => dlg.close();
}
export const act = (fn) => async (e) => {
  try {
    await fn(e);
  } catch (err) {
    toast(err.message, true);
  }
};

export const clientId = crypto.randomUUID();
export async function invoke(name, payload) {
  const out = await api('/api/converter/invoke/' + name, {
    method: 'POST',
    body: payload,
    headers: { 'X-Client-Id': clientId },
  });
  if (!out?.ok) throw new Error(out?.error?.code || 'Converter request failed');
  return out.value;
}
