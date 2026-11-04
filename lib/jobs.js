// Egyszerre egy háttérfeladat fut (egy gépen, egy GPU-n). Az eseményeket SSE-n kapják a böngészők.
import * as store from './store.js';
import { runJob, describe } from './pipeline.js';

const clients = new Set();
const MAX_LOG = 80;
let current = null;
let last = null;
let seq = 0;

function pub(job) {
  if (!job) return null;
  const { id, projectId, type, label, startedAt, endedAt, state, error } = job;
  return { id, projectId, type, label, startedAt, endedAt, state, error };
}

function broadcast(ev) {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(data);
}

export function addClient(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const j = current || last;
  res.write(`data: ${JSON.stringify({ type: 'snapshot', job: pub(j), log: j?.log || [] })}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  res.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

export const isBusy = projectId => Boolean(current && (!projectId || current.projectId === projectId));
export const currentJob = () => pub(current);

export function stop() {
  if (!current) return false;
  current.controller.abort();
  return true;
}

export async function start(projectId, spec) {
  if (current) throw Object.assign(new Error(`Már fut egy feladat: ${current.label}`), { status: 409 });
  const project = await store.get(projectId);
  const job = {
    id: ++seq,
    projectId,
    type: spec.type,
    label: describe(project, spec),
    startedAt: new Date().toISOString(),
    state: 'running',
    controller: new AbortController(),
    log: [],
  };
  current = job;

  const push = entry => {
    job.log.push(entry);
    if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
    broadcast({ type: 'log', entry });
  };

  const ctx = {
    project,
    signal: job.controller.signal,
    status: text => push({ kind: 'status', text, at: new Date().toISOString() }),
    stream: (role, model, title) => {
      const entry = { kind: 'stream', role, model, title, text: '', thinking: '' };
      push(entry);
      return {
        token: t => {
          entry.text += t;
          broadcast({ type: 'token', text: t });
        },
        thinking: t => {
          entry.thinking += t;
          broadcast({ type: 'think', text: t });
        },
      };
    },
    save: async () => {
      await store.save(project);
      broadcast({ type: 'saved', projectId });
    },
  };

  broadcast({ type: 'job', job: pub(job) });
  ctx.status(`Indul: ${job.label}`);

  (async () => {
    try {
      await runJob(ctx, spec);
      job.state = 'done';
      ctx.status('Kész.');
    } catch (e) {
      if (e.name === 'AbortError' || job.controller.signal.aborted) {
        job.state = 'stopped';
        ctx.status('Leállítva.');
      } else {
        job.state = 'error';
        job.error = e.message;
        push({ kind: 'error', text: e.message });
        console.error(e);
      }
    } finally {
      job.endedAt = new Date().toISOString();
      last = job;
      current = null;
      broadcast({ type: 'job', job: pub(job) });
      broadcast({ type: 'saved', projectId });
    }
  })();

  return pub(job);
}
