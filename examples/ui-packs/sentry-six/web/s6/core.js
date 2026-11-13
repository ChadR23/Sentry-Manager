export const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
/** A request that never reached the server (connection dropped, server busy or restarting). */
export const OFFLINE_TEXT = "Can't reach Sentry Six Manager right now. Check the connection and try again.";
export const offline = (e) =>
  !!e?.offline || (e instanceof TypeError && /fetch|import|network|load failed/i.test(e.message || ''));
const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
export async function api(path, { method, body, check = () => {}, ...rest } = {}, retried = false) {
  check();
  rest.signal?.throwIfAborted();
  const verb = method || (body === undefined ? 'GET' : 'POST');
  let res, data;
  // a busy server can drop a connection now and then: reads are tried again
  // quietly; a change (POST, PUT, DELETE) is not, so it never happens twice
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(path, {
        ...rest,
        method: verb,
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'sentry-six-manager',
          ...rest.headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // the connection can also drop while the answer arrives; only an
      // answer that isn't JSON counts as empty
      data = await res.json().catch((e) => {
        if (e?.name === 'SyntaxError') return {};
        throw e;
      });
      break;
    } catch (e) {
      if (e?.name === 'AbortError' || rest.signal?.aborted) throw e;
      if (verb !== 'GET' || attempt >= 3)
        throw Object.assign(new Error(OFFLINE_TEXT), { offline: true, cause: e });
      await wait([500, 1500, 4000][attempt], rest.signal);
      check();
    }
  }
  check();
  rest.signal?.throwIfAborted();
  if (res.status === 401 && !path.startsWith('/api/auth/')) location.href = '/login';
  if (res.status === 403 && data.code === 'CONFIRM_PASSWORD' && !retried) {
    if (!(await confirmPassword({ signal: rest.signal, check })))
      throw new DOMException('Cancelled', 'AbortError');
    check();
    rest.signal?.throwIfAborted();
    return api(path, { method, body, check, ...rest }, true);
  }
  if (!res.ok)
    throw Object.assign(new Error(data.error || res.statusText), {
      status: res.status,
    });
  return data;
}
export function toast(text, bad = false) {
  const el = document.createElement('div');
  el.className = 'toast ' + (bad ? 'bad' : '');
  // the browser's own words for a dropped connection (a raw fetch, a page module)
  el.textContent = /^(Failed to fetch|NetworkError|Load failed|network error)/i.test(String(text))
    ? OFFLINE_TEXT
    : text;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 6000);
}
export function confirmDialog({ title, body, ok = 'Confirm', danger = false, onConfirm, signal }) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2><div>${body}</div><footer><button value="cancel" type="button">Cancel</button><button value="ok" class="${danger ? 'danger' : 'primary'}">${esc(ok)}</button></footer></form>`;
    document.body.append(dlg);
    dlg.querySelector('[value=cancel]').onclick = () => dlg.close('cancel');
    const abort = () => dlg.close('cancel');
    signal?.addEventListener('abort', abort, { once: true });
    dlg.onclose = () => {
      signal?.removeEventListener('abort', abort);
      const yes = !signal?.aborted && dlg.returnValue === 'ok';
      if (yes) onConfirm?.(dlg.querySelector('form'));
      dlg.remove();
      resolve(yes);
    };
    dlg.showModal();
  });
}
export async function confirmPassword({ signal, check = () => {} } = {}) {
  let password = '';
  const yes = await confirmDialog({
    signal,
    title: 'Confirm with your password',
    body: '<label>Password<input type="password" autocomplete="current-password" name="password" required></label>',
    onConfirm: (form) => {
      password = form.querySelector('input').value;
    },
  });
  if (!yes || signal?.aborted) return false;
  check();
  await api('/api/auth/confirm', { body: { password }, signal, check }, true);
  signal?.throwIfAborted();
  return true;
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
    if (err.name === 'AbortError') return;
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

// A scope owns all asynchronous work started for one route, vehicle and local state.
// The watcher closes prompts immediately when a key changes; checks at request
// boundaries also cover changes made before the next browser event/timer turn.
export function scope(keyParts = () => [], { signal, alive = () => true } = {}) {
  const controller = new AbortController();
  const key = () =>
    JSON.stringify([
      location.hash.split('?')[0],
      typeof keyParts === 'function' ? keyParts() : keyParts,
    ]);
  const initial = key();
  const abort = () => controller.abort();
  const valid = () => {
    if (!controller.signal.aborted && (signal?.aborted || !alive() || key() !== initial)) abort();
    return !controller.signal.aborted;
  };
  const check = () => {
    valid();
    controller.signal.throwIfAborted();
  };
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setInterval(valid, 20);
  timer.unref?.();
  window.addEventListener('hashchange', valid);
  controller.signal.addEventListener(
    'abort',
    () => {
      clearInterval(timer);
      signal?.removeEventListener('abort', abort);
      window.removeEventListener('hashchange', valid);
    },
    { once: true },
  );
  const guarded =
    (fn) =>
    async (...args) => {
      check();
      const out = await fn(...args);
      check();
      return out;
    };
  const request = guarded((path, options = {}) =>
    api(path, {
      ...options,
      check,
      signal: options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal,
    }),
  );
  const dialog = async (options) => {
    if (!valid()) return false;
    const yes = await confirmDialog({
      ...options,
      signal: options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal,
    });
    return valid() && yes;
  };
  return {
    signal: controller.signal,
    alive: valid,
    check,
    abort,
    api: request,
    wait: guarded((promise) => promise),
    confirmDialog: dialog,
    confirmPassword: guarded(async () => {
      if (!(await confirmPassword({ signal: controller.signal, check })))
        throw new DOMException('Cancelled', 'AbortError');
      return true;
    }),
    toast: (...args) => {
      if (valid()) toast(...args);
    },
    fetch: guarded((url, options = {}) => fetch(url, { ...options, signal: controller.signal })),
    invoke: async (name, payload, options = {}) => {
      const out = await request('/api/converter/invoke/' + name, {
        ...options,
        method: 'POST',
        body: payload,
        headers: { 'X-Client-Id': clientId },
      });
      if (!out?.ok) throw new Error(out?.error?.code || 'Converter request failed');
      return out.value;
    },
  };
}

const owners = new WeakMap();
export function ownedRender(renderPage) {
  return async (el, ctx) => {
    const previous = owners.get(el);
    if (previous !== ctx.scope) previous?.abort();
    const owner = scope(() => [ctx.current?.()?.id], {
      signal: ctx.scope?.signal,
      alive: ctx.alive,
    });
    owners.set(el, owner);
    const child = { ...ctx, scope: owner, alive: owner.alive };
    let teardown,
      disposed = false;
    const dispose = () => {
      if (teardown && !disposed) {
        disposed = true;
        teardown();
      }
    };
    owner.signal.addEventListener('abort', dispose, { once: true });
    try {
      teardown = await renderPage(el, child);
    } catch (err) {
      owner.abort();
      if (err.name !== 'AbortError') throw err;
    }
    const stop = () => {
      owner.abort();
      dispose();
    };
    if (!owner.alive()) stop();
    return stop;
  };
}
