import { createHash } from 'node:crypto';

import { summarize } from './parser.mjs';
import { fieldsFor } from './schema.mjs';

// These IDs and the field keys never depend on a filename. Saved plots can
// therefore keep the same composition as files arrive, disappear or change.
export function buildMonitors(streams, previous = new Map()) {
  return new Map(
    ['master', 'slave'].map((module) => {
      const id = `all-${module}`;
      const members = [...streams.values()].filter((stream) => stream.module === module);
      const version = createHash('sha256')
        .update(JSON.stringify(members.map((stream) => [stream.id, stream.version])))
        .digest('hex');
      if (previous.get(id)?.version === version) return [id, previous.get(id)];

      const fields = fieldsFor(module);
      if (module === 'slave') {
        for (const key of ['b103', 'b104', 'b107', 'b108']) {
          const field = fields.find((item) => item.key === key);
          fields.push({
            key: `csv${key}`,
            name: `CSV original: ${field.name}`,
            group: 'CSV originals',
            unit: 'raw',
            bytes: field.bytes
          });
        }
      }
      const unique = [];
      const duplicates = [];
      const hashes = new Set();
      for (const member of members) {
        const hash = `${member.sourceKind}:${member.digest}`;
        if (hashes.has(hash)) duplicates.push(member.source);
        else {
          hashes.add(hash);
          unique.push(member);
        }
      }
      const rows = unique.flatMap((member) =>
        member.rows.map((row) => ({ ...row, source: member.source }))
      );
      rows.sort(
        (a, b) =>
          (a.utc ?? Infinity) - (b.utc ?? Infinity) ||
          a.source.localeCompare(b.source) ||
          a.row - b.row
      );
      const sum = (key) => unique.reduce((total, member) => total + member[key], 0);
      const monitor = {
        id,
        version,
        module,
        fields,
        rows,
        scope: 'monitor',
        batch: '全部檔案 · 自動累積',
        source: unique.map((member) => member.source).join('; '),
        sourceKind: 'aggregate',
        sourceCount: unique.length,
        sources: unique.map((member) => member.source),
        duplicates,
        invalidUTC: sum('invalidUTC'),
        invalidValues: sum('invalidValues'),
        rejectedRows: sum('rejectedRows'),
        counterBacktracks: sum('counterBacktracks'),
        repeatedCounters: sum('repeatedCounters'),
        checksumFailures: unique.some((member) => member.checksumFailures === null)
          ? null
          : sum('checksumFailures'),
        warnings: [
          ...new Set(unique.flatMap((member) => member.warnings)),
          'All inbox batches for this module share a permanent telemetry source. Raw packet counters are not unwrapped across files.',
          ...(duplicates.length
            ? [`Identical file copies counted once: ${duplicates.join(', ')}`]
            : [])
        ]
      };
      monitor.summary = summarize(monitor);
      return [id, monitor];
    })
  );
}
