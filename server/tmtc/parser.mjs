import { fieldsFor, packetUTC } from './schema.mjs';

// The decoder writes simple semicolon-delimited records. Quoted headers/cells,
// BOMs and CRLF are also accepted; a partial final record is never published.
export function splitRecord(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === ';' && !quoted) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  if (quoted) {
    throw new Error('Unclosed CSV quote');
  }
  cells.push(cell.trim());
  return cells;
}

function numeric(cell, hex = false) {
  if (
    cell === undefined ||
    cell === '' ||
    !(hex ? /^(?:0x)?[\da-f]+$/i : /^[+-]?\d+(?:\.\d+)?$/).test(cell)
  ) {
    return null;
  }
  const value = hex ? Number.parseInt(cell.replace(/^0x/i, ''), 16) : Number(cell);
  return Number.isFinite(value) ? value : null;
}

export function parseTMTC(text, kind, options = {}) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const headers = splitRecord(lines.shift() || '');
  const raw = kind === 'all';
  const legacy = (options.decodedCsvProfile ?? 'gtm-gui-legacy') === 'gtm-gui-legacy';
  const inSpace = raw ? headers.includes('Pre-Byte 0') : headers.includes('GICD Year');
  if (
    raw
      ? !headers.includes('Byte 127')
      : !headers.includes('Packet Counter') || !headers.includes('ICD Year')
  ) {
    throw new Error('Unsupported TMTC CSV header');
  }
  const modules = raw ? ['master', 'slave'] : [kind];
  const streams = new Map(
    modules.map((module) => [
      module,
      {
        module,
        fields: fieldsFor(module, inSpace),
        rows: [],
        invalidUTC: 0,
        invalidValues: 0,
        counterBacktracks: 0,
        repeatedCounters: 0,
        checksumFailures: raw ? 0 : null,
        warnings: []
      }
    ])
  );
  const rawIndices = Array.from({ length: 128 }, (_, i) => headers.indexOf(`Byte ${i}`));
  for (const stream of streams.values()) {
    stream.csvIndices = new Map();
    for (const field of stream.fields) {
      const indices = headers.flatMap((h, i) => (h === (field.csvName || field.name) ? [i] : []));
      stream.csvIndices.set(
        field.key,
        indices[field.occurrence || 0] ?? headers.indexOf(`Bytes ${field.key.slice(1)}`)
      );
    }
    if (!raw && legacy && stream.module === 'slave') {
      for (const key of ['b103', 'b104', 'b107', 'b108']) {
        const field = stream.fields.find((f) => f.key === key);
        stream.fields.push({
          key: `csv${key}`,
          name: `CSV original: ${field.name}`,
          group: 'CSV originals',
          unit: 'raw',
          bytes: field.bytes,
          original: key
        });
      }
    }
  }
  const preIndices = Array.from({ length: 16 }, (_, i) => headers.indexOf(`Pre-Byte ${i}`));
  if (raw && (rawIndices.includes(-1) || (inSpace && preIndices.includes(-1)))) {
    throw new Error('Missing raw byte columns');
  }
  let rejectedRows = 0;
  let lastError = '';
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    if (!lines[lineIndex].trim()) {
      continue;
    }
    try {
      const cells = splitRecord(lines[lineIndex]);
      if (cells.length !== headers.length) {
        throw new Error(`Expected ${headers.length} columns, received ${cells.length}`);
      }
      let bytes;
      let pre;
      let module = kind;
      if (raw) {
        bytes = rawIndices.map((i) => numeric(cells[i]));
        pre = inSpace ? preIndices.map((i) => numeric(cells[i])) : [];
        if (![...bytes, ...pre].every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) {
          throw new Error('Invalid raw byte');
        }
        if (
          bytes[0] !== 0x55 ||
          bytes[1] !== 0xaa ||
          bytes[126] !== 0xfb ||
          bytes[127] !== 0xf2 ||
          ![2, 5].includes(bytes[2])
        ) {
          throw new Error('Invalid packet header, tail or GTM ID');
        }
        module = bytes[2] === 2 ? 'master' : 'slave';
      }
      const stream = streams.get(module);
      const values = {};
      for (const field of stream.fields) {
        if (field.derive || field.original) {
          continue;
        }
        if (raw) {
          values[field.key] = field.read(bytes, pre);
        } else {
          const index = stream.csvIndices.get(field.key);
          const hex = ['b0', 'b126'].includes(field.key) || /SPW#.*Status/.test(field.name);
          values[field.key] = numeric(cells[index], hex);
        }
      }
      if (!raw && legacy && module === 'slave') {
        for (const key of ['b103', 'b104', 'b107', 'b108']) {
          values[`csv${key}`] = values[key];
        }
        [values.b103, values.b104] = [values.b104, values.b103];
        const hvCurrent = values.b108;
        const hvVoltage = values.b107;
        values.b107 =
          hvCurrent === null || hvVoltage === null
            ? null
            : Math.floor(hvCurrent / 16) * 16 + (hvVoltage % 16);
        values.b108 =
          hvCurrent === null || hvVoltage === null
            ? null
            : Math.floor(hvVoltage / 16) * 16 + (hvCurrent % 16);
      }
      for (const field of stream.fields.filter((f) => f.derive)) {
        values[field.key] = field.derive(values);
      }
      if (
        !Number.isInteger(values.b3) ||
        values.b3 < 0 ||
        values.b3 > 65535 ||
        values.b2 !== (module === 'master' ? 0 : 1)
      ) {
        throw new Error('Invalid packet counter or module ID');
      }
      // The current C decoder writes icd_second into ICD Subsecond. Do not
      // fabricate fractional timestamps from decoded-only input, even if a
      // raw-byte subsecond scale is configured.
      const utc = packetUTC(values, raw || !legacy ? options.subsecondMilliseconds ?? null : null);
      if (utc === null) {
        stream.invalidUTC++;
      }
      stream.invalidValues += Object.values(values).filter((v) => v === null).length;
      const previous = stream.rows.at(-1);
      if (previous && values.b3 < previous.packet) {
        stream.counterBacktracks++;
      }
      if (previous && values.b3 === previous.packet) {
        stream.repeatedCounters++;
      }
      if (raw && bytes.slice(2, 125).reduce((a, b) => a + b, 0) % 256 !== bytes[125]) {
        stream.checksumFailures++;
      }
      stream.rows.push({ utc, packet: values.b3, row: lineIndex + 2, values });
    } catch (error) {
      rejectedRows++;
      lastError = `Line ${lineIndex + 2}: ${error.message}`;
    }
  }
  for (const stream of streams.values()) {
    stream.rejectedRows = rejectedRows;
    if (lastError) {
      stream.warnings.push(`${rejectedRows} rejected rows. ${lastError}`);
    }
    stream.warnings.push('UTC uses ICD packet time (not GICD reception time).');
    if (!raw && legacy) {
      stream.warnings.push(
        'Decoded-only input: ICD Subsecond is unreliable in the current C decoder; UTC uses whole seconds. Raw values are preserved.'
      );
      if (stream.module === 'slave') {
        stream.warnings.push(
          'Legacy decoder correction applied: swapped CSV current/voltage columns and reconstructed HV low nibbles per ICD rev L. Original CSV values are separate channels. Set decodedCsvProfile=icd for a corrected decoder.'
        );
      }
    } else if (
      options.subsecondMilliseconds === null ||
      options.subsecondMilliseconds === undefined
    ) {
      stream.warnings.push(
        'Subsecond unit is unspecified in the supplied ICD; raw subsecond is retained, UTC uses whole seconds.'
      );
    }
    if (stream.counterBacktracks || stream.repeatedCounters) {
      stream.warnings.push(
        'Raw packet counters are preserved, including resets/wraps/repeats. Counter plots sort by counter and may overlap cycles; use UTC to inspect chronology.'
      );
    }
  }
  if (![...streams.values()].some((s) => s.rows.length)) {
    throw new Error(`No valid packets. ${lastError}`);
  }
  return [...streams.values()].filter((s) => s.rows.length);
}

export function summarize(stream) {
  const range = (get) => {
    let start = Infinity;
    let end = -Infinity;
    for (const row of stream.rows) {
      const value = get(row);
      if (value !== null && Number.isFinite(value)) {
        start = Math.min(start, value);
        end = Math.max(end, value);
      }
    }
    return Number.isFinite(start) ? { start, end } : null;
  };
  return {
    module: stream.module,
    count: stream.rows.length,
    invalidUTC: stream.invalidUTC,
    distinctUTC: new Set(stream.rows.map((row) => row.utc).filter((utc) => utc !== null)).size,
    invalidValues: stream.invalidValues,
    rejectedRows: stream.rejectedRows,
    counterBacktracks: stream.counterBacktracks,
    repeatedCounters: stream.repeatedCounters,
    checksumFailures: stream.checksumFailures,
    warnings: stream.warnings,
    bounds: { utc: range((r) => r.utc), packet: range((r) => r.packet) },
    fields: stream.fields.map(({ read, derive, ...field }) => ({
      ...field,
      ...range((r) => r.values[field.key]),
      last: stream.rows.at(-1)?.values[field.key] ?? null
    }))
  };
}

export function querySeries(stream, field, domain, start = -Infinity, end = Infinity) {
  if (!['utc', 'packet'].includes(domain) || !stream.fields.some((f) => f.key === field)) {
    throw new Error('Unknown field or domain');
  }
  return stream.rows
    .filter(
      (r) =>
        Number.isFinite(r[domain]) &&
        r[domain] >= start &&
        r[domain] <= end &&
        Number.isFinite(r.values[field])
    )
    .map((r) => ({
      utc: r.utc,
      packet: r.packet,
      value: r.values[field],
      row: r.row,
      ...(r.source ? { source: r.source } : {})
    }))
    .sort(
      (a, b) =>
        a[domain] - b[domain] ||
        (a.source !== b.source ? (a.utc ?? Infinity) - (b.utc ?? Infinity) : 0) ||
        (a.source || '').localeCompare(b.source || '') ||
        a.row - b.row
    );
}
