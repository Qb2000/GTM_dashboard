import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { parseTMTC, querySeries, splitRecord, summarize } from './parser.mjs';
import { packetUTC } from './schema.mjs';
import { createTMTCService } from './service.mjs';

function packet(module = 2, counter = 42) {
  const b = Array(128).fill(0);
  Object.assign(b, {
    0: 85,
    1: 170,
    2: module,
    3: Math.floor(counter / 256),
    4: counter % 256,
    6: 120,
    7: 7,
    8: 232,
    9: 0,
    10: 60,
    11: 12,
    12: 34,
    13: 56,
    14: 128,
    20: 255,
    21: 30,
    22: 254,
    24: 254,
    26: 190,
    27: 188,
    28: 31,
    100: 242,
    103: 18,
    104: 52,
    105: 171,
    106: 254,
    107: 86,
    108: 120,
    109: 205,
    114: 1,
    115: 2,
    116: 3,
    117: 4,
    126: 251,
    127: 242
  });
  b[125] = b.slice(2, 125).reduce((a, v) => a + v, 0) % 256;
  return b;
}

function rawCSV(rows, inSpace = false) {
  const prefix = inSpace ? Array.from({ length: 16 }, (_, i) => `Pre-Byte ${i}`) : [];
  const headers = [...prefix, ...Array.from({ length: 128 }, (_, i) => `Byte ${i}`)];
  const pre = [8, 145, 192, 12, 0, 137, 7, 232, 0, 60, 12, 34, 57, 64, 0, 0];
  return (
    '\uFEFF' +
    [headers.join(';'), ...rows.map((b) => [...(inSpace ? pre : []), ...b].join(';'))].join(
      '\r\n'
    ) +
    '\r\n'
  );
}

test('ICD byte values, signed fields, exact HV nibbles, engineering values and distinct SEE channels', () => {
  const [master, slave] = parseTMTC(rawCSV([packet(), packet(5)]), 'all');
  const m = master.rows[0].values;
  const s = slave.rows[0].values;
  assert.equal(m.b20, -1);
  assert.equal(m.b22, -2);
  assert.equal(m.b26, 12499999);
  assert.equal(m.percent26, 100);
  assert.equal(m.periodMs, 1000);
  assert.deepEqual([m.b114, m.b115, m.b116, m.b117], [1, 2, 3, 4]);
  assert.deepEqual([s.b103, s.b104, s.b107, s.b108], [0x12a, 0x34b, 0x56d, 0x78c]);
  assert.equal(s.amps103, 0x12a * 5.324e-4);
  assert.equal(s.volts108, 0x78c * 0.01442);
  assert.equal(s.celsius106, -0.96);
  assert.equal(master.checksumFailures, 0);
  assert.equal(slave.checksumFailures, 0);
  assert.equal(new Set(master.fields.map((f) => f.key)).size, master.fields.length);
});

test('packet UTC uses ICD year and DOY, not GICD or host timezone; raw subsecond opt-in', () => {
  const [stream] = parseTMTC(rawCSV([packet()], true), 'all');
  assert.equal(stream.rows[0].utc, Date.UTC(2024, 1, 29, 12, 34, 56));
  const [fractional] = parseTMTC(rawCSV([packet()]), 'all', { subsecondMilliseconds: 1000 / 256 });
  assert.equal(fractional.rows[0].utc, Date.UTC(2024, 1, 29, 12, 34, 56, 500));
  assert.equal(packetUTC({ b7: 2023, b9: 366, b11: 0, b12: 0, b13: 0 }), null);
  assert.equal(packetUTC({ b7: 2024, b9: 0, b11: 0, b12: 0, b13: 0 }), null);
});

test('invalid UTC packets remain available by raw counter; wrap and duplicate packets are preserved', () => {
  const badTime = packet(2, 0);
  badTime[7] = 0;
  badTime[8] = 0;
  const [stream] = parseTMTC(rawCSV([packet(2, 65535), badTime, packet(2, 0)]), 'all');
  assert.equal(stream.invalidUTC, 1);
  assert.equal(stream.counterBacktracks, 1);
  assert.equal(stream.repeatedCounters, 1);
  assert.equal(querySeries(stream, 'b20', 'utc').length, 2);
  assert.deepEqual(
    querySeries(stream, 'b20', 'packet', 0, 0).map((r) => r.row),
    [3, 4]
  );
  assert.equal(querySeries(stream, 'b20', 'packet').length, 3);
  assert.throws(() => querySeries(stream, 'missing', 'packet'), /Unknown/);
});

test('corrupt bytes and partial rows are rejected visibly; bad checksum remains inspectable', () => {
  const invalid = packet();
  invalid[40] = 256;
  const badChecksum = packet(2, 44);
  badChecksum[125] = (badChecksum[125] + 1) % 256;
  const [stream] = parseTMTC(rawCSV([packet(), invalid, badChecksum]) + '1;2;3\n', 'all');
  assert.equal(stream.rows.length, 2);
  assert.equal(stream.rejectedRows, 2);
  assert.equal(stream.checksumFailures, 1);
  assert.ok(stream.warnings.some((w) => w.includes('rejected')));
  assert.throws(() => parseTMTC('not;tmtc\n1;2', 'all'), /header/);
});

const legacyHeaders =
  'Header;GTM ID;Packet Counter;ICD Year;ICD Day;ICD Hour;ICD Minute;ICD Second;ICD Subsecond;Input Current Value;Input Voltage Value;HV Input Current Value;HV Input Voltage Value;SEE counts of uRAM;SEE counts of uRAM;SPW#A Status;Tail';
const legacyRow = '55AA;1;42;2024;60;12;34;56;56;843;298;1933;1388;3;9;20;FBF2';

test('legacy decoder swap/HV correction preserves original CSV values and duplicate column names', () => {
  const [stream] = parseTMTC(`${legacyHeaders}\n${legacyRow}\n`, 'slave', {
    subsecondMilliseconds: 4
  });
  const v = stream.rows[0].values;
  assert.deepEqual([v.b103, v.b104, v.b107, v.b108], [298, 843, 0x56d, 0x78c]);
  assert.deepEqual([v.csvb103, v.csvb104, v.csvb107, v.csvb108], [843, 298, 1933, 1388]);
  assert.deepEqual([v.b114, v.b115], [3, 9]);
  assert.equal(stream.rows[0].utc, Date.UTC(2024, 1, 29, 12, 34, 56));
  assert.equal(stream.checksumFailures, null);
  assert.equal(v.b20, null); // Missing cells must not turn into zero telemetry.
});

test('corrected CSV profile bypasses legacy changes; hex-only decimal-looking strings parse as hex', () => {
  const [slave] = parseTMTC(`${legacyHeaders}\n${legacyRow}\n`, 'slave', {
    decodedCsvProfile: 'icd'
  });
  assert.equal(slave.rows[0].values.b103, 843);
  const [master] = parseTMTC(
    `${legacyHeaders}\n${legacyRow.replace(';1;42;', ';0;42;')}\n`,
    'master'
  );
  assert.equal(master.rows[0].values.b107, 32);
  assert.deepEqual(splitRecord('"x;y";"a""b"; 0 '), ['x;y', 'a"b', '0']);
});

test('folder service waits for stable files, ignores companions, refreshes replacements and deletions, validates API', async (t) => {
  const tempRoot = path.resolve('tmp');
  await mkdir(tempRoot, { recursive: true });
  const inbox = await mkdtemp(path.join(tempRoot, 'tmtc-test-'));
  let service;
  let server;
  t.after(async () => {
    service?.close();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    assert.ok(inbox.startsWith(tempRoot + path.sep));
    await rm(inbox, { recursive: true, force: true });
  });
  service = await createTMTCService(process.cwd(), {
    inputDirectory: inbox,
    settleMilliseconds: 20,
    pollMilliseconds: 100000
  });
  assert.equal(service.catalog().datasets.length, 0);
  const source = path.join(inbox, 'sample_tmtc_all.csv');
  await writeFile(source, rawCSV([packet(), packet(5)]));
  await writeFile(path.join(inbox, 'sample_tmtc_slave.csv'), `${legacyHeaders}\n${legacyRow}\n`);
  await service.refresh();
  assert.equal(service.catalog().datasets.length, 0);
  assert.equal(service.catalog().files.find((f) => f.kind === 'all').status, 'waiting');
  await new Promise((resolve) => setTimeout(resolve, 30));
  await service.refresh();
  assert.equal(service.catalog().datasets.length, 2);
  assert.equal(service.catalog().files.find((f) => f.kind === 'slave').status, 'companion');
  const dataset = service.catalog().datasets.find((d) => d.module === 'master');
  const revision = service.catalog().revision;
  server = createServer((req, res) =>
    service.middleware(req, res, () => {
      res.statusCode = 404;
      res.end();
    })
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/tmtc`;
  const rows = await (
    await fetch(`${base}/series?id=${dataset.id}&field=b20&domain=packet&start=42&end=42`)
  ).json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, -1);
  assert.equal(
    (await fetch(`${base}/series?id=${dataset.id}&field=b20&domain=packet&start=10&end=0`)).status,
    400
  );
  assert.equal((await fetch(`${base}/series?id=../../secret&field=b20`)).status, 404);
  assert.equal((await fetch(`${base}/catalog`, { method: 'POST' })).status, 405);
  await writeFile(source, rawCSV([packet(), packet(2, 43), packet(5)]));
  await service.refresh();
  assert.equal(service.catalog().datasets.find((d) => d.module === 'master').count, 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await service.refresh();
  assert.equal(service.catalog().datasets.find((d) => d.module === 'master').count, 2);
  assert.notEqual(service.catalog().revision, revision);
  await writeFile(source, 'broken');
  await service.refresh();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await service.refresh();
  assert.equal(service.catalog().datasets.find((d) => d.module === 'master').count, 2);
  assert.equal(service.catalog().errors.length, 1);
  await rm(source);
  await service.refresh();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await service.refresh();
  assert.equal(service.catalog().datasets.length, 1);
  assert.equal(service.catalog().datasets[0].sourceKind, 'slave');
});

test('Open MCT client exposes every channel with both x domains and uses packet-domain query bounds', async () => {
  const source = await readFile('src/plugins/tmtc/TMTCClient.js', 'utf8');
  const { default: TMTCClient, fitDataset } = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  );
  const client = new TMTCClient('/api/tmtc');
  const [stream] = parseTMTC(rawCSV([packet()]), 'all');
  const dataset = {
    ...summarize(stream),
    id: 'test-master',
    source: 'sample_tmtc_all.csv',
    batch: 'sample'
  };
  client.catalog = { datasets: [dataset] };
  const groupIds = client.children('d:test-master');
  assert.equal(groupIds.flatMap((id) => client.children(id.key)).length, dataset.fields.length);
  const object = client.object('f:test-master:b20');
  assert.deepEqual(
    object.telemetry.values.filter((v) => v.hints?.domain).map((v) => v.key),
    ['utc', 'packet']
  );
  let selected;
  const openmct = {
    time: {
      setMode: () => {},
      setTimeSystem: (axis, bounds) => {
        selected = { axis, bounds };
      }
    }
  };
  assert.equal(fitDataset(openmct, dataset, 'packet'), true);
  assert.deepEqual(selected, { axis: 'packet', bounds: { start: 41, end: 43 } });
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      assert.ok(url.includes('domain=packet'));
      assert.ok(url.includes('start=40'));
      return { ok: true, json: async () => [{ packet: 42, value: -1 }] };
    };
    assert.deepEqual(await client.request(object, { domain: 'packet', start: 40, end: 50 }), [
      { packet: 42, value: -1 }
    ]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('permanent monitor sources include later files, survive restart/removal and retain raw counter resets', async (t) => {
  const tempRoot = path.resolve('tmp');
  await mkdir(tempRoot, { recursive: true });
  const inbox = await mkdtemp(path.join(tempRoot, 'tmtc-monitor-test-'));
  let service;
  let server;
  t.after(async () => {
    service?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    assert.ok(inbox.startsWith(tempRoot + path.sep));
    await rm(inbox, { recursive: true, force: true });
  });
  const config = { inputDirectory: inbox, settleMilliseconds: 0, pollMilliseconds: 100000 };
  service = await createTMTCService(process.cwd(), config);
  assert.deepEqual(
    service.catalog().monitors.map((d) => [d.id, d.count]),
    [
      ['all-master', 0],
      ['all-slave', 0]
    ]
  );
  server = createServer((req, res) => service.middleware(req, res, () => res.end()));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/tmtc`;
  // This is the exact URL a saved plot continues to request after new arrivals.
  const fixedURL = `${base}/series?id=all-master&field=b20&domain=utc`;
  const firstFile = path.join(inbox, 'z_first_tmtc_all.csv');
  await writeFile(firstFile, rawCSV([packet(2, 100), packet(5, 99)]));
  await service.refresh();
  const fields = service.catalog().monitors[0].fields.map((field) => field.key);
  const firstVersion = service.catalog().monitors[0].version;
  assert.equal((await (await fetch(fixedURL)).json()).length, 1);
  const later = packet(2, 3); // A new session resets the raw counter.
  later[13] = 59;
  later[20] = 35;
  later[125] = later.slice(2, 125).reduce((a, b) => a + b, 0) % 256;
  const secondFile = path.join(inbox, 'a_later_tmtc_all.csv');
  const laterCSV = rawCSV([later]);
  await writeFile(secondFile, laterCSV);
  await service.refresh();
  const rows = await (await fetch(fixedURL)).json();
  assert.deepEqual(
    rows.map((row) => [row.packet, row.value, row.source]),
    [
      [100, -1, 'z_first_tmtc_all.csv'],
      [3, 35, 'a_later_tmtc_all.csv']
    ]
  );
  assert.ok(rows[1].utc > rows[0].utc);
  assert.notEqual(service.catalog().monitors[0].version, firstVersion);
  assert.deepEqual(
    service.catalog().monitors[0].fields.map((field) => field.key),
    fields
  );
  assert.equal(service.catalog().monitors[1].count, 1); // Never mix modules.
  assert.deepEqual(
    (await (await fetch(fixedURL.replace('domain=utc', 'domain=packet'))).json()).map(
      (r) => r.packet
    ),
    [3, 100]
  );
  await writeFile(path.join(inbox, 'copy_tmtc_all.csv'), laterCSV);
  await service.refresh();
  assert.equal(service.catalog().monitors[0].count, 2);
  assert.equal(service.catalog().monitors[0].duplicates.length, 1);
  service.close();
  service = await createTMTCService(process.cwd(), config);
  assert.equal((await (await fetch(fixedURL)).json()).length, 2);
  assert.deepEqual(await (await fetch(fixedURL + '&start=' + rows[1].utc)).json(), [rows[1]]);
  for (const file of [firstFile, secondFile, path.join(inbox, 'copy_tmtc_all.csv')]) await rm(file);
  await service.refresh();
  assert.equal(service.catalog().monitors[0].id, 'all-master');
  assert.deepEqual(await (await fetch(fixedURL)).json(), []);
});

test('saved plots inside layouts refresh when their permanent sources change, including independent bounds', async () => {
  const source = await readFile('src/plugins/tmtc/refreshViews.js', 'utf8');
  const { collectTMTCViews, refreshTMTCViews } = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  );
  const object = (key, type, extra = {}) => ({
    identifier: { namespace: '', key },
    type,
    ...extra
  });
  const master = object('master', 'tmtc.channel', { tmtc: { dataset: 'all-master' } });
  const slave = object('slave', 'tmtc.channel', { tmtc: { dataset: 'all-slave' } });
  const plot = object('saved-plot', 'telemetry.plot.overlay');
  const separate = object('separate-plot', 'telemetry.plot.overlay');
  const other = object('old-plot', 'telemetry.plot.overlay');
  const layout = object('saved-layout', 'flexible-layout');
  const compositions = new Map([
    [layout, [plot, separate, other]],
    [plot, [master]],
    [separate, [slave]],
    [other, [object('other-channel', 'other.telemetry')]]
  ]);
  const context = (axis, initial) => ({
    bounds: initial,
    getMode: () => 'fixed',
    getTimeSystem: () => ({ key: axis }),
    getBounds() {
      return this.bounds;
    },
    setBounds(bounds) {
      this.bounds = bounds;
    }
  });
  const global = context('utc', { start: 1000, end: 3000 });
  const independent = context('packet', { start: 0, end: 10 });
  const reloaded = [];
  const openmct = {
    composition: { get: (obj) => ({ load: async () => compositions.get(obj) || [] }) },
    time: { getContextForView: (path) => (path[0] === separate ? independent : global) },
    objectViews: { emit: (event, obj) => reloaded.push(obj.identifier.key) }
  };
  const views = await collectTMTCViews(openmct, [layout]);
  assert.deepEqual(
    views.map((view) => view.object.identifier.key),
    ['saved-plot', 'separate-plot']
  );
  const client = {
    dataset: () => ({
      scope: 'monitor',
      bounds: { utc: { start: 2000, end: 9000 }, packet: { start: 3, end: 500 } }
    })
  };
  refreshTMTCViews(openmct, client, views, new Set(['all-master']));
  assert.deepEqual(reloaded, ['saved-plot']);
  assert.deepEqual(global.bounds, { start: 1000, end: 10000 });
  assert.deepEqual(independent.bounds, { start: 0, end: 10 });
  refreshTMTCViews(openmct, client, views, new Set(['all-slave']));
  assert.equal(independent.bounds.end, 504.97);
  assert.deepEqual(reloaded, ['saved-plot', 'separate-plot']);
  global.getMode = () => 'realtime';
  global.bounds = { start: 1000, end: 3000 };
  refreshTMTCViews(openmct, client, views, new Set(['all-master']));
  assert.deepEqual(global.bounds, { start: 1000, end: 3000 });
});
