// Daylight: what every page shares (vehicles, the chosen vehicle, alerts,
// live updates). Pages subscribe with on(topic) and get the server's
// "changed" topics as they arrive.

import { api, store, esc } from './core.js';

const listeners = new Map(); // topic -> Set(fn)
export function on(topic, fn) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(fn);
  return () => listeners.get(topic)?.delete(fn);
}
export function emit(topic, data) {
  for (const fn of [...(listeners.get(topic) || [])]) {
    try { fn(data); } catch (err) { console.warn(err); }
  }
}

export const state = {
  vehicles: [],
  vehicleId: store.get('vehicle', null),
  openNotes: [],
  runningJobs: [],
  converter: null, // latest converter snapshot (see encoder live)
  system: null,
  loaded: false
};

export const vehicle = () => state.vehicles.find((v) => v.id === state.vehicleId) || state.vehicles[0] || null;
export const vehicleById = (id) => state.vehicles.find((v) => v.id === id) || null;

export function setVehicle(id) {
  if (!state.vehicles.some((v) => v.id === id)) return;
  state.vehicleId = id;
  store.set('vehicle', id);
  emit('vehicle', id);
}

export async function loadVehicles() {
  const { vehicles } = await api('/api/vehicles');
  state.vehicles = vehicles;
  if (!vehicle() && vehicles.length) state.vehicleId = vehicles[0].id;
  emit('vehicles', vehicles);
  return vehicles;
}

export async function loadNotes() {
  const { notifications } = await api('/api/notifications?open=1');
  state.openNotes = notifications;
  emit('notes', notifications);
  return notifications;
}

export async function loadJobs() {
  const { jobs } = await api('/api/jobs?limit=50');
  state.runningJobs = jobs.filter((j) => j.status === 'running');
  emit('jobs-running', state.runningJobs);
  return jobs;
}

export const unreadCount = () => state.openNotes.filter((n) => !n.readAt).length;
export const binCount = () => state.vehicles.reduce((n, v) => n + (v.binItems || 0), 0);

/** The vehicle picker shown at the top of pages that work per vehicle. */
export function vehiclePicker({ allowAll = false, selected = undefined, id = 'vehicle-pick' } = {}) {
  if (!state.vehicles.length) return '';
  const current = selected === undefined ? vehicle()?.id : selected;
  if (state.vehicles.length === 1 && !allowAll) {
    return `<span class="vehicle-solo chip">${esc(state.vehicles[0].name)}</span>`;
  }
  return `<label class="vehicle-select"><span class="sr-only">Vehicle</span><select class="input" id="${id}">
    ${allowAll ? `<option value=""${current ? '' : ' selected'}>All vehicles</option>` : ''}
    ${state.vehicles.map((v) => `<option value="${esc(v.id)}"${v.id === current ? ' selected' : ''}>${esc(v.name)}</option>`).join('')}
  </select></label>`;
}

/** Health of a vehicle's footage source in plain words. */
export function shareHealth(v) {
  const s = v?.share;
  if (!s) return { tone: 'grey', word: 'Not connected yet', ok: false };
  if (!s.healthy) return { tone: 'bad', word: 'Can’t reach the footage', ok: false, detail: s.lastError || s.hint || '' };
  if (s.writable === false) return { tone: 'warn', word: 'Read-only: we can look but not tidy up', ok: true, detail: s.lastError || '' };
  return { tone: 'good', word: 'Connected', ok: true };
}
