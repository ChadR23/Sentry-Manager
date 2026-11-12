import { countText, plural, size } from './format.js';
export function describeJob(job) {
  const status = job.status || 'running',
    r = job.result || {},
    n = Array.isArray(r.moved) ? r.moved.length : 0;
  let title = job.title || job.type || 'Job',
    outcome = job.detail || '';
  if (job.type === 'trash' && status === 'done') {
    title = `Moved ${plural(n, 'recording')} to the Recycle Bin`;
    outcome = `${Number.isFinite(r.bytes) ? size(r.bytes) + ' · ' : ''}you can restore them`;
  }
  if (job.type === 'restore')
    title =
      status === 'done'
        ? 'Restored footage from the Recycle Bin'
        : 'Restore footage from the Recycle Bin';
  if (job.type === 'restore' && status === 'done')
    outcome = 'Back where it was' + (r.bytes != null ? ' · ' + size(r.bytes) : '');
  if (['convert', 'conversion'].includes(job.type) && ['interrupted', 'cancelled'].includes(status))
    outcome =
      (outcome ? outcome + ' · ' : '') +
      'Any finished clips stay converted. Review what remains in the Encoder.';
  if (status === 'failed') outcome = job.error || job.detail || 'Could not finish.';
  return {
    icon:
      {
        trash: 'delete',
        restore: 'restore',
        convert: 'conversion_path',
        conversion: 'conversion_path',
        scan: 'folder_open',
        export: 'videocam',
      }[job.type] || 'task',
    title: countText(title),
    outcome: countText(outcome),
    status,
    statusText:
      {
        done: 'Done',
        failed: 'Failed',
        interrupted: 'Interrupted',
        cancelled: 'Cancelled',
        waiting: 'Waiting',
        paused: 'Paused',
        running: 'Running',
      }[status] || status,
  };
}
export function jobProgress(job) {
  const m = /Rendering (.+?) of (.+?) \((\d+(?:\.\d+)?)%\)/.exec(job.detail || '');
  return m && Number(m[3]) >= 0 && Number(m[3]) <= 100
    ? { pct: Number(m[3]), text: m[1] + ' of ' + m[2] }
    : null;
}
