export const NAMESPACE = 'gtm-tmtc';
export function identifier(key) {
  return { namespace: NAMESPACE, key };
}

export default class TMTCClient {
  constructor(apiUrl) {
    this.apiUrl = apiUrl;
    this.catalog = { datasets: [], files: [], errors: [] };
    this.listeners = new Set();
    this.error = '';
  }

  refresh() {
    if (this.pending) {
      return this.pending;
    }
    this.pending = this.fetchCatalog().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  async fetchCatalog() {
    try {
      const response = await fetch(`${this.apiUrl}/catalog`, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`TMTC API: HTTP ${response.status}`);
      }
      const next = await response.json();
      const previous = this.catalog;
      const changed = next.revision !== previous.revision || this.error;
      this.error = '';
      this.catalog = next;
      if (changed) {
        this.listeners.forEach((listener) => listener(next, previous));
      }
    } catch (error) {
      this.error = `TMTC 服務無法連線：${error.message}。請確認以 npm start 啟動服務。`;
      this.listeners.forEach((listener) => listener(this.catalog, this.catalog));
    }
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dataset(id) {
    return this.datasets().find((d) => d.id === id);
  }

  datasets(catalog = this.catalog) {
    return [...(catalog.monitors || []), ...catalog.datasets];
  }

  groups(dataset) {
    return [...new Set(dataset.fields.map((f) => f.group))];
  }

  children(key, catalog = this.catalog) {
    if (key === 'root') {
      return [...(catalog.monitors || []).map((d) => identifier(`d:${d.id}`)), identifier('files')];
    }
    if (key === 'files') {
      return catalog.datasets.map((d) => identifier(`d:${d.id}`));
    }
    const [kind, id, group] = key.split(':');
    const dataset = this.datasets(catalog).find((d) => d.id === id);
    if (!dataset) {
      return [];
    }
    if (kind === 'd') {
      return this.groups(dataset).map((g, i) => identifier(`g:${id}:${i}`));
    }
    if (kind === 'g') {
      return dataset.fields
        .filter((f) => f.group === this.groups(dataset)[Number(group)])
        .map((f) => identifier(`f:${id}:${f.key}`));
    }
    return [];
  }

  object(key) {
    const base = {
      identifier: identifier(key),
      type: 'tmtc.catalog',
      location: `${NAMESPACE}:root`
    };
    if (key === 'root') {
      return { ...base, name: 'GTM TMTC', location: 'ROOT', composition: [] };
    }
    if (key === 'files') {
      return { ...base, name: '個別檔案（診斷用）', composition: [] };
    }
    const [kind, id, fieldKey] = key.split(':');
    const dataset = this.dataset(id);
    if (!dataset) {
      return undefined;
    }
    const tmtc = { dataset: id };
    if (kind === 'd') {
      return {
        ...base,
        name:
          dataset.scope === 'monitor'
            ? `${dataset.module.toUpperCase()} · 全部 TMTC`
            : `${dataset.batch} / ${dataset.module.toUpperCase()}`,
        location: `${NAMESPACE}:${dataset.scope === 'monitor' ? 'root' : 'files'}`,
        tmtc,
        composition: []
      };
    }
    if (kind === 'g') {
      return {
        ...base,
        name: this.groups(dataset)[Number(fieldKey)],
        location: `${NAMESPACE}:d:${id}`,
        tmtc,
        composition: []
      };
    }
    const field = dataset.fields.find((f) => f.key === fieldKey);
    if (kind !== 'f' || !field) {
      return undefined;
    }
    return {
      ...base,
      type: 'tmtc.channel',
      name:
        dataset.scope === 'monitor'
          ? `${dataset.module.toUpperCase()} · ${field.name}`
          : field.name,
      location: `${NAMESPACE}:g:${id}:${this.groups(dataset).indexOf(field.group)}`,
      tmtc: { ...tmtc, field: fieldKey },
      description: `${dataset.scope === 'monitor' ? 'Permanent source: all current and future inbox files' : dataset.source}; ${dataset.module}; ICD rev L Table 5-4; bytes ${field.bytes || 'derived'}. ${field.description || ''}`,
      telemetry: {
        values: [
          {
            key: 'value',
            name: field.name,
            units: field.unit,
            format: 'float',
            hints: { range: 1 }
          },
          { key: 'utc', name: 'Packet UTC (ICD)', format: 'utc', hints: { domain: 1 } },
          { key: 'packet', name: 'Packet Counter', format: 'tmtc-counter', hints: { domain: 2 } },
          { key: 'row', name: 'CSV source row', format: 'integer' },
          { key: 'source', name: 'Source file', format: 'string' }
        ]
      }
    };
  }

  async request(object, options = {}) {
    const params = new URLSearchParams({
      id: object.tmtc.dataset,
      field: object.tmtc.field,
      domain: options.domain || 'utc'
    });
    for (const key of ['start', 'end', 'strategy']) {
      if (options[key] !== undefined) {
        params.set(key, options[key]);
      }
    }
    const response = await fetch(`${this.apiUrl}/series?${params}`, {
      cache: 'no-store',
      signal: options.signal
    });
    if (!response.ok) {
      throw new Error(`TMTC request failed: HTTP ${response.status}`);
    }
    return response.json();
  }
}

export function fitDataset(openmct, dataset, axis) {
  const bounds = dataset?.bounds[axis];
  if (!bounds) {
    openmct.notifications.error('此資料目前沒有可用的軸範圍，請確認已有有效封包。');
    return false;
  }
  const padding = Math.max(axis === 'utc' ? 1000 : 1, (bounds.end - bounds.start) * 0.01);
  openmct.time.setMode('fixed');
  openmct.time.setTimeSystem(axis, { start: bounds.start - padding, end: bounds.end + padding });
  return true;
}
