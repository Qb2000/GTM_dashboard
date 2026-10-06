// abc.js
const ADC_URL = '/data/converted_json/ADC.json';
const GTM_NAMESPACE = 'gtm';
const ROOT_KEY = 'gtm';
const ADC_FOLDER_KEY = 'adc';
const DEFAULT_BIN_SIZE_MS = 1000;
const DEFAULT_COUNT_THRESHOLD = 0;

function buildTelemetryMetadata() {
    return {
        values: [
            {
                key: 'ADC value',
                name: 'ADC value',
                format: 'float',
                units: 'ADC',
                hints: { range: 2 }
            },
            {
                key: 'count rate',
                name: 'Count Rate',
                format: 'float',
                units: 'count/s',
                hints: { range: 1 }
            },
            {
                key: 'utc',
                name: 'Time',
                format: 'utc',
                hints: { domain: 1 }
            }
        ]
    };
}

function parseKey(key) {
    if (key === ROOT_KEY) {
        return { kind: 'root' };
    }

    if (key === ADC_FOLDER_KEY) {
        return { kind: 'adcFolder' };
    }

    if (key.startsWith('sensor:')) {
        return { kind: 'sensorFolder', sensorName: key.slice('sensor:'.length) };
    }

    if (key.startsWith('sensorlc:')) {
        return { kind: 'sensorTelemetry', sensorName: key.slice('sensorlc:'.length) };
    }

    if (key.startsWith('channel:')) {
        const parts = key.split(':');
        if (parts.length === 3) {
            return {
                kind: 'channelTelemetry',
                sensorName: parts[1],
                channel: Number(parts[2])
            };
        }
    }

    return { kind: 'unknown' };
}

function normalizeBinSizeMs(options) {
    const requested = options && typeof options.binningMs === 'number'
        ? options.binningMs
        : DEFAULT_BIN_SIZE_MS;

    if (!Number.isFinite(requested) || requested <= 0) {
        return DEFAULT_BIN_SIZE_MS;
    }

    return requested;
}

function normalizeCountThreshold(options, domainObject) {
    const optionThreshold = options && typeof options.countThreshold === 'number'
        ? options.countThreshold
        : null;
    const objectThreshold = domainObject && typeof domainObject.countThreshold === 'number'
        ? domainObject.countThreshold
        : null;

    if (optionThreshold !== null && Number.isFinite(optionThreshold)) {
        return optionThreshold;
    }

    if (objectThreshold !== null && Number.isFinite(objectThreshold)) {
        return objectThreshold;
    }

    return DEFAULT_COUNT_THRESHOLD;
}

function createBinnedTelemetry(rows, binSizeMs, countThreshold, start, end) {
    const bins = new Map();
    let minUtc = Number.POSITIVE_INFINITY;
    let maxUtc = Number.NEGATIVE_INFINITY;

    rows.forEach(function (row) {
        const utc = Number(row.utc);
        const adcValue = Number(row['ADC value']);
        if (!Number.isFinite(utc) || !Number.isFinite(adcValue)) {
            return;
        }
        minUtc = Math.min(minUtc, utc);
        maxUtc = Math.max(maxUtc, utc);

        const binStart = Math.floor(utc / binSizeMs) * binSizeMs;
        if (!bins.has(binStart)) {
            bins.set(binStart, {
                utc: binStart + (binSizeMs / 2),
                count: 0,
                adcSum: 0,
                eventCount: 0
            });
        }

        const bin = bins.get(binStart);
        bin.count += 1;
        bin.adcSum += adcValue;
        if (adcValue >= countThreshold) {
            bin.eventCount += 1;
        }
    });

    const hasRangeFromOptions = Number.isFinite(start) && Number.isFinite(end) && end >= start;
    const hasRangeFromData = Number.isFinite(minUtc) && Number.isFinite(maxUtc) && maxUtc >= minUtc;
    if (!hasRangeFromOptions && !hasRangeFromData) {
        return [];
    }

    const rangeStart = hasRangeFromOptions ? start : minUtc;
    const rangeEnd = hasRangeFromOptions ? end : maxUtc;
    const firstBinStart = Math.floor(rangeStart / binSizeMs) * binSizeMs;
    const lastBinStart = Math.floor(rangeEnd / binSizeMs) * binSizeMs;

    const results = [];
    for (let binStart = firstBinStart; binStart <= lastBinStart; binStart += binSizeMs) {
        const bin = bins.get(binStart);
        if (bin) {
            results.push({
                utc: bin.utc,
                'ADC value': bin.adcSum / bin.count,
                'count rate': bin.eventCount / (binSizeMs / 1000)
            });
            continue;
        }

        results.push({
            utc: binStart + (binSizeMs / 2),
            'ADC value': null,
            'count rate': 0
        });
    }

    return results
        .sort(function (a, b) { return a.utc - b.utc; })
        .map(function (bin) {
            return {
                utc: bin.utc,
                'ADC value': bin['ADC value'],
                'count rate': bin['count rate']
            };
        });
}

function gtmTelemetryPlugin() {
    let adcRows = [];
    let sensorChannels = {};
    let loadPromise = null;

    function loadAdcData() {
        if (loadPromise) {
            return loadPromise;
        }

        loadPromise = fetch(ADC_URL)
            .then(function (response) {
                if (!response.ok) {
                    throw new Error('Cannot load telemetry JSON: ' + ADC_URL);
                }
                return response.json();
            })
            .then(function (rows) {
                adcRows = Array.isArray(rows) ? rows : [];

                const grouped = {};
                adcRows.forEach(function (row) {
                    const sensorName = row['Sensor Name'];
                    const channel = Number(row['Sensor Channel']);
                    if (!sensorName || Number.isNaN(channel)) {
                        return;
                    }

                    if (!grouped[sensorName]) {
                        grouped[sensorName] = new Set();
                    }
                    grouped[sensorName].add(channel);
                });

                sensorChannels = {};
                Object.keys(grouped)
                    .sort()
                    .forEach(function (sensorName) {
                        sensorChannels[sensorName] = Array.from(grouped[sensorName]).sort(function (a, b) {
                            return a - b;
                        });
                    });
            })
            .catch(function (error) {
                console.error('Load ADC telemetry failed:', error);
                adcRows = [];
                sensorChannels = {};
            });

        return loadPromise;
    }

    function toIdentifier(key) {
        return { namespace: GTM_NAMESPACE, key: key };
    }

    return function install(openmct) {
        openmct.objects.addRoot(toIdentifier(ROOT_KEY));

        openmct.types.addType('gtm.telemetry', {
            name: 'GTM ADC Channel',
            description: 'Single sensor channel light curve from ADC.json',
            icon: 'icon-telemetry'
        });

        openmct.objects.addProvider(GTM_NAMESPACE, {
            get: function (identifier) {
                return loadAdcData().then(function () {
                    const parsed = parseKey(identifier.key);

                    if (parsed.kind === 'root') {
                        return {
                            identifier: identifier,
                            name: 'GTM Data',
                            type: 'folder',
                            location: 'ROOT'
                        };
                    }

                    if (parsed.kind === 'adcFolder') {
                        return {
                            identifier: identifier,
                            name: 'ADC',
                            type: 'folder',
                            location: GTM_NAMESPACE + ':' + ROOT_KEY
                        };
                    }

                    if (parsed.kind === 'sensorFolder' && sensorChannels[parsed.sensorName]) {
                        return {
                            identifier: identifier,
                            name: parsed.sensorName + ' (all channels)',
                            type: 'folder',
                            location: GTM_NAMESPACE + ':' + ADC_FOLDER_KEY
                        };
                    }

                    if (parsed.kind === 'sensorTelemetry' && sensorChannels[parsed.sensorName]) {
                        return {
                            identifier: identifier,
                            name: parsed.sensorName + '_Combined',
                            type: 'gtm.telemetry',
                            telemetry: buildTelemetryMetadata(),
                            location: GTM_NAMESPACE + ':sensor:' + parsed.sensorName,
                            gtmSelection: {
                                sensorName: parsed.sensorName,
                                aggregateSensor: true
                            }
                        };
                    }

                    if (parsed.kind === 'channelTelemetry' && sensorChannels[parsed.sensorName]) {
                        return {
                            identifier: identifier,
                            name: parsed.sensorName + ' - CH' + parsed.channel,
                            type: 'gtm.telemetry',
                            telemetry: buildTelemetryMetadata(),
                            location: GTM_NAMESPACE + ':sensor:' + parsed.sensorName,
                            gtmSelection: {
                                sensorName: parsed.sensorName,
                                channel: parsed.channel
                            }
                        };
                    }

                    return undefined;
                });
            }
        });

        openmct.composition.addProvider({
            appliesTo: function (domainObject) {
                return domainObject.identifier.namespace === GTM_NAMESPACE && domainObject.type === 'folder';
            },
            load: function (domainObject) {
                return loadAdcData().then(function () {
                    const parsed = parseKey(domainObject.identifier.key);

                    if (parsed.kind === 'root') {
                        return [toIdentifier(ADC_FOLDER_KEY)];
                    }

                    if (parsed.kind === 'adcFolder') {
                        return Object.keys(sensorChannels).map(function (sensorName) {
                            return toIdentifier('sensor:' + sensorName);
                        });
                    }

                    if (parsed.kind === 'sensorFolder') {
                        const channels = sensorChannels[parsed.sensorName] || [];
                        const sensorAggregate = [toIdentifier('sensorlc:' + parsed.sensorName)];
                        const channelIdentifiers = channels.map(function (channel) {
                            return toIdentifier('channel:' + parsed.sensorName + ':' + channel);
                        });
                        return sensorAggregate.concat(channelIdentifiers);
                    }

                    return [];
                });
            }
        });

        openmct.telemetry.addProvider({
            supportsRequest: function (domainObject) {
                return domainObject.type === 'gtm.telemetry';
            },
            request: function (domainObject, options) {
                return loadAdcData().then(function () {
                    const selection = domainObject.gtmSelection;
                    if (!selection) {
                        return [];
                    }

                    const start = options && typeof options.start === 'number' ? options.start : Number.NEGATIVE_INFINITY;
                    const end = options && typeof options.end === 'number' ? options.end : Number.POSITIVE_INFINITY;
                    const binSizeMs = normalizeBinSizeMs(options);
                    const countThreshold = normalizeCountThreshold(options, domainObject);

                    const filteredRows = adcRows
                        .filter(function (row) {
                            const utc = Number(row.utc);
                            const isTargetSensor = row['Sensor Name'] === selection.sensorName;
                            const isTargetChannel = selection.aggregateSensor
                                ? true
                                : Number(row['Sensor Channel']) === selection.channel;
                            return (
                                isTargetSensor &&
                                isTargetChannel &&
                                Number.isFinite(utc) &&
                                utc >= start &&
                                utc <= end
                            );
                        });

                    return createBinnedTelemetry(filteredRows, binSizeMs, countThreshold, start, end);
                });
            }
        });

        console.log('GTM telemetry plugin installed (ADC dynamic tree).');
    };
}