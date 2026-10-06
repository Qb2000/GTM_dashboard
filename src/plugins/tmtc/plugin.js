import mount from 'utils/mount';

import { collectTMTCViews, refreshTMTCViews } from './refreshViews.js';
import TMTCClient, { fitDataset, identifier, NAMESPACE } from './TMTCClient.js';
import TMTCQuickLook from './TmtcQuickLook.vue';

export default function TMTCPlugin({ apiUrl = '/api/tmtc', refreshMilliseconds = 3000 } = {}) {
  return function install(openmct) {
    const client = new TMTCClient(apiUrl);
    const ready = client.refresh();
    const timer = setInterval(() => client.refresh(), refreshMilliseconds);
    openmct.on('destroy', () => clearInterval(timer));

    openmct.telemetry.addFormat({
      key: 'tmtc-counter',
      format: (value) => String(Math.round(value)),
      parse: (value) => Number(value),
      validate: (value) => String(value).trim() !== '' && Number.isFinite(Number(value))
    });
    openmct.time.addTimeSystem({
      key: 'packet',
      name: 'Packet Counter',
      cssClass: 'icon-telemetry',
      timeFormat: 'tmtc-counter',
      durationFormat: 'tmtc-counter',
      isUTCBased: false
    });
    openmct.types.addType('tmtc.catalog', { name: 'TMTC Catalog', cssClass: 'icon-folder' });
    openmct.types.addType('tmtc.channel', { name: 'TMTC Channel', cssClass: 'icon-telemetry' });
    openmct.objects.addRoot(identifier('root'));
    openmct.objects.addProvider(NAMESPACE, {
      async get(id) {
        await ready;
        return client.object(id.key);
      }
    });
    const listeners = [];
    openmct.composition.addProvider({
      appliesTo: (object) =>
        object.identifier.namespace === NAMESPACE && object.type === 'tmtc.catalog',
      async load(object) {
        await ready;
        return client.children(object.identifier.key);
      },
      on(object, event, callback, context) {
        listeners.push({ key: object.identifier.key, event, callback, context });
      },
      off(object, event, callback, context) {
        for (let i = listeners.length - 1; i >= 0; i--) {
          const l = listeners[i];
          if (
            l.key === object.identifier.key &&
            l.event === event &&
            l.callback === callback &&
            l.context === context
          ) {
            listeners.splice(i, 1);
          }
        }
      }
    });
    const pendingChanges = new Set();
    async function updateVisiblePlots() {
      if (openmct.editor.isEditing()) {
        return;
      }
      const path = openmct.router.path;
      const views = await collectTMTCViews(openmct, path);
      if (path !== openmct.router.path || openmct.editor.isEditing()) {
        return;
      }
      const changed = new Set(pendingChanges);
      pendingChanges.clear();
      refreshTMTCViews(openmct, client, views, changed);
    }
    function refreshSafely() {
      updateVisiblePlots().catch((error) => console.error('TMTC plot refresh failed', error));
    }
    function afterEdit(editing) {
      if (!editing) {
        refreshSafely();
      }
    }
    openmct.editor.on('isEditing', afterEdit);
    openmct.on('destroy', () => openmct.editor.off('isEditing', afterEdit));
    client.onChange((next, previous) => {
      listeners.forEach((listener) => {
        const before = client.children(listener.key, previous);
        const after = client.children(listener.key, next);
        const added = after.filter((id) => !before.some((old) => old.key === id.key));
        const removed = before.filter((id) => !after.some((fresh) => fresh.key === id.key));
        const changed = { add: added, remove: removed }[listener.event] || [];
        changed.forEach((id) => listener.callback.call(listener.context, id));
      });
      const before = new Map(client.datasets(previous).map((d) => [d.id, d.version]));
      const after = new Map(client.datasets(next).map((d) => [d.id, d.version]));
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        if (before.get(id) !== after.get(id)) {
          pendingChanges.add(id);
        }
      }
      if (pendingChanges.size) {
        refreshSafely();
      }
    });
    openmct.telemetry.addProvider({
      supportsRequest: (object) => object.type === 'tmtc.channel',
      request: (object, options) => client.request(object, options)
    });
    let savedTimeContext;
    let browsingTMTC = false;
    async function handleNavigation() {
      const path = openmct.router.path;
      const object = path?.[0];
      const views = await collectTMTCViews(openmct, path);
      if (path !== openmct.router.path) {
        return;
      }
      const isTMTC = object?.identifier.namespace === NAMESPACE || views.length > 0;
      if (isTMTC && !browsingTMTC && openmct.time.getTimeSystem().key !== 'packet') {
        savedTimeContext = {
          system: openmct.time.getTimeSystem().key,
          bounds: openmct.time.getBounds(),
          mode: openmct.time.getMode(),
          offsets: openmct.time.getClockOffsets()
        };
      }
      if (!isTMTC && browsingTMTC && savedTimeContext) {
        openmct.time.setTimeSystem(savedTimeContext.system, savedTimeContext.bounds);
        openmct.time.setMode(
          savedTimeContext.mode,
          savedTimeContext.mode === 'realtime' ? savedTimeContext.offsets : savedTimeContext.bounds
        );
        savedTimeContext = undefined;
      }
      browsingTMTC = isTMTC;
      if (object?.type === 'tmtc.channel') {
        const axis = openmct.time.getTimeSystem().key === 'packet' ? 'packet' : 'utc';
        fitDataset(openmct, client.dataset(object.tmtc.dataset), axis);
      }
    }
    function onNavigate() {
      handleNavigation().catch((error) => console.error('TMTC navigation failed', error));
    }
    openmct.router.on('afterNavigation', onNavigate);
    openmct.on('destroy', () => openmct.router.off('afterNavigation', onNavigate));
    function onModeChanged(mode) {
      if (mode === 'realtime' && openmct.time.getTimeSystem().key === 'packet') {
        openmct.time.setMode('fixed');
        openmct.notifications.info('Packet Counter 使用固定範圍，請以 UTC 使用即時時鐘。');
      }
    }
    openmct.time.on('modeChanged', onModeChanged);
    openmct.on('destroy', () => openmct.time.off('modeChanged', onModeChanged));
    for (const axis of ['utc', 'packet']) {
      openmct.actions.register({
        key: `tmtc-plot-${axis}`,
        name:
          axis === 'utc'
            ? 'TMTC: Plot by UTC / Fit range'
            : 'TMTC: Plot by Packet Counter / Fit range',
        group: 'view',
        cssClass: 'icon-plot',
        priority: 1,
        appliesTo: (objectPath) =>
          objectPath[0]?.type === 'tmtc.channel' ||
          (objectPath[0]?.type === 'telemetry.plot.overlay' &&
            objectPath[0].composition?.some((id) => id.namespace === NAMESPACE)),
        async invoke(objectPath) {
          const views = await collectTMTCViews(openmct, objectPath);
          const datasets = [...new Set(views.flatMap((view) => view.ids))].map((id) =>
            client.dataset(id)
          );
          const ranges = datasets.map((dataset) => dataset?.bounds[axis]).filter(Boolean);
          const bounds = ranges.length
            ? {
                start: Math.min(...ranges.map((range) => range.start)),
                end: Math.max(...ranges.map((range) => range.end))
              }
            : null;
          fitDataset(openmct, { bounds: { [axis]: bounds } }, axis);
        }
      });
    }
    openmct.objectViews.addProvider({
      key: 'tmtc-quicklook',
      name: 'TMTC Quick Look',
      cssClass: 'icon-telemetry',
      priority: 1,
      canView: (object) => object.type === 'tmtc.catalog',
      view(domainObject) {
        let destroy;
        return {
          show(element) {
            ({ destroy } = mount(
              {
                el: element,
                components: { TMTCQuickLook },
                provide: { openmct, domainObject, tmtcClient: client },
                template: '<TMTCQuickLook />'
              },
              { app: openmct.app, element }
            ));
          },
          destroy() {
            destroy?.();
          }
        };
      }
    });
  };
}
