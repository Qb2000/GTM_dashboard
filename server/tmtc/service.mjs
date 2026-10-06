import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { parseTMTC, querySeries, summarize } from './parser.mjs';
import { buildMonitors } from './monitors.mjs';

export async function createTMTCService(projectRoot, overrides = {}) {
  const config = {
    ...JSON.parse(await readFile(path.join(projectRoot, 'tmtc.config.json'), 'utf8')),
    ...overrides
  };
  const inputDirectory = path.resolve(
    projectRoot,
    process.env.TMTC_INPUT_DIR || config.inputDirectory
  );
  if (!['gtm-gui-legacy', 'icd'].includes(config.decodedCsvProfile)) {
    throw new Error('decodedCsvProfile must be gtm-gui-legacy or icd');
  }
  for (const key of ['pollMilliseconds', 'settleMilliseconds']) {
    if (
      !Number.isFinite(config[key]) ||
      config[key] < 0 ||
      (key === 'pollMilliseconds' && config[key] < 100)
    ) {
      throw new Error(`Invalid TMTC setting: ${key}`);
    }
  }
  if (
    config.subsecondMilliseconds !== null &&
    (!Number.isFinite(config.subsecondMilliseconds) || config.subsecondMilliseconds <= 0)
  ) {
    throw new Error('subsecondMilliseconds must be null or a positive number');
  }
  const observed = new Map();
  const cached = new Map();
  let streams = new Map();
  let monitors = buildMonitors(streams);
  let catalog = { revision: '', inputDirectory, datasets: [], files: [], errors: [] };
  let inFlight;
  let stopped = false;
  async function scan() {
    let entries;
    try {
      entries = await readdir(inputDirectory, { withFileTypes: true });
    } catch (error) {
      publish(streams, catalog.files, [
        `Cannot read inbox: ${error.message}; retaining previous data.`
      ]);
      return;
    }
    const files = entries
      .filter((e) => e.isFile() && /_tmtc_(all|master|slave)\.csv$/i.test(e.name))
      .map((e) => {
        const [, batch, kind] = e.name.match(/^(.*)_tmtc_(all|master|slave)\.csv$/i);
        return { name: e.name, batch, kind: kind.toLowerCase() };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    const rawBatches = new Set(files.filter((f) => f.kind === 'all').map((f) => f.batch));
    const nextStreams = new Map();
    const statuses = [];
    const errors = [];
    const present = new Set(files.map((f) => f.name));
    for (const name of cached.keys()) {
      if (!present.has(name)) {
        cached.delete(name);
        observed.delete(name);
      }
    }
    for (const file of files) {
      if (file.kind !== 'all' && rawBatches.has(file.batch)) {
        statuses.push({
          ...file,
          status: 'companion',
          message: 'Matching _all.csv is authoritative; not counted twice.'
        });
        continue;
      }
      let status = 'ready';
      let message = '';
      try {
        const filename = path.join(inputDirectory, file.name);
        const info = await stat(filename);
        const stamp = `${info.size}:${info.mtimeMs}`;
        const before = observed.get(file.name);
        if (!before || before.stamp !== stamp) {
          observed.set(file.name, { stamp, since: Date.now() });
        }
        const observation = observed.get(file.name);
        if (Date.now() - observation.since < config.settleMilliseconds) {
          status = 'waiting';
          message =
            'Waiting for the copy/write to finish; retaining the previous valid snapshot if any.';
        } else if (cached.get(file.name)?.stamp !== stamp) {
          const source = await readFile(filename, 'utf8');
          const after = await stat(filename);
          if (`${after.size}:${after.mtimeMs}` !== stamp) {
            status = 'waiting';
            message = 'File changed during read; retrying next scan.';
          } else {
            const parsed = parseTMTC(source, file.kind, config);
            const digest = createHash('sha256').update(source).digest('hex');
            const idPrefix = createHash('sha256').update(file.batch).digest('hex').slice(0, 24);
            cached.set(file.name, {
              stamp,
              streams: parsed.map((stream) => ({
                ...stream,
                id: `${idPrefix}-${stream.module}`,
                batch: file.batch,
                source: file.name,
                sourceKind: file.kind,
                digest,
                version: `${stamp}:${digest}`,
                summary: summarize(stream)
              }))
            });
          }
        }
      } catch (error) {
        status = 'error';
        message = error.message;
        errors.push(`${file.name}: ${message}`);
      }
      for (const stream of cached.get(file.name)?.streams || []) {
        nextStreams.set(stream.id, stream);
      }
      statuses.push({ ...file, status, message });
    }
    publish(nextStreams, statuses, errors);
  }
  function publish(nextStreams, files, errors) {
    streams = nextStreams;
    monitors = buildMonitors(streams, monitors);
    const datasets = [...streams.values()].map((s) => ({
      ...s.summary,
      id: s.id,
      batch: s.batch,
      source: s.source,
      sourceKind: s.sourceKind,
      version: s.version
    }));
    const monitorCatalog = [...monitors.values()].map((s) => ({
      ...s.summary,
      id: s.id,
      version: s.version,
      scope: s.scope,
      batch: s.batch,
      source: s.source,
      sourceKind: s.sourceKind,
      sources: s.sources,
      sourceCount: s.sourceCount,
      duplicates: s.duplicates
    }));
    const revision = createHash('sha256')
      .update(JSON.stringify({ datasets, monitors: monitorCatalog, files, errors }))
      .digest('hex');
    catalog = {
      revision,
      inputDirectory,
      datasets,
      monitors: monitorCatalog,
      files,
      errors,
      pollMilliseconds: config.pollMilliseconds
    };
  }
  async function refresh() {
    if (!inFlight) {
      inFlight = scan().finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  }
  await refresh();
  const timer = setInterval(() => {
    if (!stopped) {
      refresh().catch((error) => console.error('[TMTC]', error));
    }
  }, config.pollMilliseconds);
  timer.unref();

  return {
    refresh,
    catalog: () => catalog,
    close() {
      stopped = true;
      clearInterval(timer);
    },
    async middleware(req, res, next) {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/api/tmtc/')) {
        next();
        return;
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      const reply = (code, value) => {
        res.statusCode = code;
        res.end(JSON.stringify(value));
      };
      if (req.method !== 'GET') {
        reply(405, { error: 'Read-only API' });
        return;
      }
      if (url.pathname === '/api/tmtc/catalog') {
        reply(200, catalog);
        return;
      }
      if (url.pathname !== '/api/tmtc/series') {
        reply(404, { error: 'Unknown TMTC endpoint' });
        return;
      }
      const dataset =
        monitors.get(url.searchParams.get('id')) || streams.get(url.searchParams.get('id'));
      if (!dataset) {
        reply(404, { error: 'Dataset not found (file may have been removed)' });
        return;
      }
      const start = url.searchParams.has('start')
        ? Number(url.searchParams.get('start'))
        : -Infinity;
      const end = url.searchParams.has('end') ? Number(url.searchParams.get('end')) : Infinity;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
        reply(400, { error: 'Invalid query bounds' });
        return;
      }
      try {
        let rows = querySeries(
          dataset,
          url.searchParams.get('field'),
          url.searchParams.get('domain') || 'utc',
          start,
          end
        );
        if (url.searchParams.get('strategy') === 'latest') {
          rows = rows.slice(-1);
        }
        reply(200, rows);
      } catch (error) {
        reply(400, { error: error.message });
      }
    }
  };
}
