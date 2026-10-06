const containers = new Set([
  'flexible-layout',
  'layout',
  'telemetry.plot.stacked',
  'telemetry.plot.overlay'
]);

// Follow displayed plots and layouts, not folders full of unopened dashboards.
// Reload affected plot widgets without rebuilding their containing layout.
export async function collectTMTCViews(openmct, path, ancestors = new Set()) {
  const object = path?.[0];
  if (!object) {
    return [];
  }
  const key = `${object.identifier.namespace}:${object.identifier.key}`;
  if (ancestors.has(key)) {
    return [];
  }
  if (object.type === 'tmtc.channel') {
    return [{ object, path, ids: [object.tmtc.dataset] }];
  }
  if (!containers.has(object.type)) {
    return [];
  }
  const composition = openmct.composition.get(object);
  if (!composition) {
    return [];
  }
  const branch = new Set([...ancestors, key]);
  const children = await composition.load();
  const nested = (
    await Promise.all(children.map((child) => collectTMTCViews(openmct, [child, ...path], branch)))
  ).flat();
  if (object.type === 'telemetry.plot.overlay' && nested.length) {
    return [{ object, path, ids: [...new Set(nested.flatMap((view) => view.ids))] }];
  }
  return nested;
}

export function refreshTMTCViews(openmct, client, views, changed, fitAll = false) {
  const affected = views.filter((view) => view.ids.some((id) => changed.has(id)));
  const contexts = new Map();
  for (const view of affected) {
    const context = openmct.time.getContextForView(view.path);
    const datasets = view.ids.map((id) => client.dataset(id)).filter((d) => d?.scope === 'monitor');
    contexts.set(context, [...(contexts.get(context) || []), ...datasets]);
  }
  for (const [context, datasets] of contexts) {
    if (context.getMode() !== 'fixed') {
      continue;
    }
    const axis = context.getTimeSystem().key;
    const ranges = datasets.map((dataset) => dataset.bounds[axis]).filter(Boolean);
    if (!ranges.length) {
      continue;
    }
    const start = Math.min(...ranges.map((range) => range.start));
    const end = Math.max(...ranges.map((range) => range.end));
    const padding = Math.max(axis === 'utc' ? 1000 : 1, (end - start) * 0.01);
    const old = context.getBounds();
    const bounds = fitAll
      ? { start: start - padding, end: end + padding }
      : {
          start: Math.min(old.start, start - padding),
          end: Math.max(old.end, end + padding)
        };
    if (bounds.start !== old.start || bounds.end !== old.end) {
      context.setBounds(bounds);
    }
  }
  for (const view of affected) {
    openmct.objectViews.emit('reload', view.object);
  }
}
