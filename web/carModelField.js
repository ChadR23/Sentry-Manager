// The vehicle settings' "Car model" and "Year" (admins: the vehicle settings are
// theirs), shared by every interface, each in its own classes:
//
//   import { carModelFields, wireCarModel, readCarModel } from '/web/carModelField.js';
//   form.innerHTML = `…${carModelFields(vehicle, { field: (text, control) => `<label class="field">${text}${control}</label>`, input: 'input', hint: 'muted small' })}…`;
//   wireCarModel(form);                       // the Year list follows the model
//   body.car = readCarModel(form);            // { model, generation } for PUT /api/vehicles/:id
//
// Automatic (the default) is what the car's VIN on the CAN bus says
// (web/carModels.js); a model and year chosen here win over it. It picks the
// DBC set the car's CAN data is decoded with: a change has the CAN logs decoded
// again in the background.
import '/web/carModels.js';

const M = globalThis.SentryCarModels;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function yearOptions(model, chosen) {
  const list = model && model !== 'auto' ? M.GENERATIONS[model] || [] : [];
  return [`<option value="auto">${list.length ? 'Automatic (from the VIN)' : 'Pick the model first'}</option>`]
    .concat(list.map((g) => `<option value="${esc(g.id)}"${g.id === chosen ? ' selected' : ''}>${esc(g.label)}</option>`)).join('');
}

/** What decodes the car's CAN data now, in words (from the vehicle's `car`, GET /api/vehicles). */
export function carModelNote(car) {
  if (!car) return 'Automatic: the car\'s VIN on the CAN bus says which car it is.';
  const det = car.detected;
  const said = det ? `The car's VIN${det.vin ? ` (${det.vin})` : ''} says ${det.model ? M.MODELS[det.model] : 'an unknown model'}${det.year ? `, model year ${det.year}` : ''}.` : 'No VIN in its CAN data yet.';
  const using = car.model ? `Decoded as a ${car.modelLabel}${car.generationLabel ? `, ${car.generationLabel}` : ''}` : 'Decoded as a Model 3/Y';
  const checked = car.model === 'Y' || !car.model ? 'checked on a real Model Y' : 'from community DBC files, not checked on a real car yet';
  return `${said} ${using} (${checked}).`;
}

/**
 * The two fields. field(text, control): one labelled field in the interface's own markup;
 * input: the class of its selects; hint: the class of the note under them.
 */
export function carModelFields(v, { field = (text, control) => `<label class="field">${text}${control}</label>`, input = 'input', hint = 'muted small' } = {}) {
  const s = M.normalizeCar(v?.car?.setting || v?.car);
  const models = [['auto', 'Automatic (from the VIN)'], ...Object.entries(M.MODELS)];
  const modelSel = `<select class="${esc(input)}" name="carModel" data-car-model>${models.map(([id, label]) => `<option value="${esc(id)}"${id === s.model ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
  const yearSel = `<select class="${esc(input)}" name="carGeneration" data-car-year${s.model === 'auto' ? ' disabled' : ''}>${yearOptions(s.model, s.generation)}</select>`;
  return `${field('Car model', modelSel)}${field('Year', yearSel)}<p class="${esc(hint)}" data-car-note style="grid-column:1/-1;margin:0">${esc(carModelNote(v?.car))} It picks how its CAN data is read; changing it reads its CAN logs again in the background.</p>`;
}

/** The Year list follows the model (and is off for Automatic). */
export function wireCarModel(form) {
  const model = form?.querySelector('[data-car-model]');
  const year = form?.querySelector('[data-car-year]');
  if (!model || !year) return;
  model.addEventListener('change', () => {
    year.innerHTML = yearOptions(model.value, 'auto');
    year.disabled = model.value === 'auto';
  });
}

/** The setting as typed: { model, generation }. */
export function readCarModel(form) {
  const model = form?.querySelector('[data-car-model]')?.value || 'auto';
  const generation = form?.querySelector('[data-car-year]')?.value || 'auto';
  return M.normalizeCar({ model, generation });
}
