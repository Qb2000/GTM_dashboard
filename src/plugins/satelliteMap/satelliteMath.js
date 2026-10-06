/*****************************************************************************
 * Open MCT, Copyright (c) 2014-2024, United States Government
 * as represented by the Administrator of the National Aeronautics and Space
 * Administration. All rights reserved.
 *
 * Open MCT is licensed under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0.
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations
 * under the License.
 *
 * Open MCT includes source code licensed under additional open source
 * licenses. See the Open Source Licenses file (LICENSES.md) included with
 * this source code distribution or the Licensing information page available
 * at runtime from the About dialog for additional information.
 *****************************************************************************/

const EARTH_RADIUS_KM = 6378.137;
const EARTH_GRAVITATIONAL_PARAMETER = 398600.4418;
const MILLISECONDS_PER_DAY = 86400000;
const SECONDS_PER_DAY = 86400;
const MINUTES_TO_MILLISECONDS = 60000;
const TWO_PI = Math.PI * 2;
const MAX_TRACK_SAMPLES = 720;

export const DEFAULT_TLE = `ISS
1 25544U 98067A   24086.84722222  .00016717  00000+0  30650-3 0  9993
2 25544  51.6416  12.4840 0004377  57.9135  47.6464 15.50052509445648`;

export const DEFAULT_SATELLITE_MAP_CONFIGURATION = {
  tle: DEFAULT_TLE,
  trackPastMinutes: 90,
  trackFutureMinutes: 90,
  sampleMinutes: 2,
  refreshSeconds: 5,
  showGrid: true
};

export function normalizeConfiguration(configuration = {}) {
  return {
    ...DEFAULT_SATELLITE_MAP_CONFIGURATION,
    ...configuration,
    trackPastMinutes: clampNumber(configuration.trackPastMinutes, 0, 1440, 90),
    trackFutureMinutes: clampNumber(configuration.trackFutureMinutes, 0, 1440, 90),
    sampleMinutes: clampNumber(configuration.sampleMinutes, 0.25, 60, 2),
    refreshSeconds: clampNumber(configuration.refreshSeconds, 1, 3600, 5),
    showGrid: configuration.showGrid !== false
  };
}

export function parseTle(tleText) {
  const lines = String(tleText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const line1Index = lines.findIndex((line) => line.startsWith('1 '));
  const line2Index = lines.findIndex((line) => line.startsWith('2 '));

  if (line1Index === -1 || line2Index === -1) {
    throw new Error('A valid two-line element set is required.');
  }

  const name = line1Index > 0 ? lines[line1Index - 1] : 'Satellite';
  const line1 = lines[line1Index];
  const line2 = lines[line2Index];
  const line1Fields = line1.split(/\s+/);
  const line2Fields = line2.split(/\s+/);

  if (line1Fields.length < 4 || line2Fields.length < 8) {
    throw new Error('The two-line element set is incomplete.');
  }

  const epochMs = parseEpoch(line1Fields[3]);
  const inclinationRad = degreesToRadians(Number(line2Fields[2]));
  const rightAscensionRad = degreesToRadians(Number(line2Fields[3]));
  const eccentricity = Number(`0.${line2Fields[4]}`);
  const argumentOfPerigeeRad = degreesToRadians(Number(line2Fields[5]));
  const meanAnomalyRad = degreesToRadians(Number(line2Fields[6]));
  const meanMotionRevsPerDay = Number(line2Fields[7]);

  if (
    !Number.isFinite(epochMs) ||
    !Number.isFinite(inclinationRad) ||
    !Number.isFinite(rightAscensionRad) ||
    !Number.isFinite(eccentricity) ||
    !Number.isFinite(argumentOfPerigeeRad) ||
    !Number.isFinite(meanAnomalyRad) ||
    !Number.isFinite(meanMotionRevsPerDay) ||
    eccentricity < 0 ||
    eccentricity >= 1 ||
    meanMotionRevsPerDay <= 0
  ) {
    throw new Error('The two-line element set contains invalid orbital values.');
  }

  const meanMotionRadPerSecond = (meanMotionRevsPerDay * TWO_PI) / SECONDS_PER_DAY;
  const semiMajorAxisKm = Math.cbrt(
    EARTH_GRAVITATIONAL_PARAMETER / Math.pow(meanMotionRadPerSecond, 2)
  );

  return {
    name,
    line1,
    line2,
    epochMs,
    inclinationRad,
    rightAscensionRad,
    eccentricity,
    argumentOfPerigeeRad,
    meanAnomalyRad,
    meanMotionRadPerSecond,
    semiMajorAxisKm
  };
}

export function propagateTle(tleRecord, timestamp) {
  const elapsedSeconds = (timestamp - tleRecord.epochMs) / 1000;
  const meanAnomaly = normalizeRadians(
    tleRecord.meanAnomalyRad + tleRecord.meanMotionRadPerSecond * elapsedSeconds
  );
  const eccentricAnomaly = solveEccentricAnomaly(meanAnomaly, tleRecord.eccentricity);
  const trueAnomaly = Math.atan2(
    Math.sqrt(1 - Math.pow(tleRecord.eccentricity, 2)) * Math.sin(eccentricAnomaly),
    Math.cos(eccentricAnomaly) - tleRecord.eccentricity
  );
  const radiusKm =
    tleRecord.semiMajorAxisKm * (1 - tleRecord.eccentricity * Math.cos(eccentricAnomaly));
  const positionEci = orbitalPlaneToEci(radiusKm, trueAnomaly, tleRecord);
  const positionEcef = eciToEcef(positionEci, timestamp);
  const hypotenuse = Math.hypot(positionEcef.x, positionEcef.y);
  const latitude = radiansToDegrees(Math.atan2(positionEcef.z, hypotenuse));
  const longitude = normalizeLongitude(
    radiansToDegrees(Math.atan2(positionEcef.y, positionEcef.x))
  );

  return {
    timestamp,
    latitude,
    longitude,
    altitudeKm: Math.max(
      0,
      Math.hypot(positionEcef.x, positionEcef.y, positionEcef.z) - EARTH_RADIUS_KM
    )
  };
}

export function generateGroundTrack(
  tleRecord,
  centerTimestamp,
  trackPastMinutes,
  trackFutureMinutes,
  sampleMinutes
) {
  const startTimestamp = centerTimestamp - trackPastMinutes * MINUTES_TO_MILLISECONDS;
  const endTimestamp = centerTimestamp + trackFutureMinutes * MINUTES_TO_MILLISECONDS;
  const requestedStepMs = sampleMinutes * MINUTES_TO_MILLISECONDS;
  const totalDurationMs = Math.max(0, endTimestamp - startTimestamp);
  const stepMs = Math.max(requestedStepMs, totalDurationMs / MAX_TRACK_SAMPLES || requestedStepMs);
  const points = [];

  for (let timestamp = startTimestamp; timestamp <= endTimestamp; timestamp += stepMs) {
    points.push(propagateTle(tleRecord, timestamp));
  }

  if (points.length === 0 || points[points.length - 1].timestamp < endTimestamp) {
    points.push(propagateTle(tleRecord, endTimestamp));
  }

  return points;
}

function clampNumber(value, min, max, fallback) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, numericValue));
}

function parseEpoch(epoch) {
  const yearPart = Number(epoch.slice(0, 2));
  const dayOfYear = Number(epoch.slice(2));

  if (!Number.isFinite(yearPart) || !Number.isFinite(dayOfYear)) {
    return Number.NaN;
  }

  const year = yearPart < 57 ? 2000 + yearPart : 1900 + yearPart;

  return Date.UTC(year, 0, 1) + (dayOfYear - 1) * MILLISECONDS_PER_DAY;
}

function solveEccentricAnomaly(meanAnomaly, eccentricity) {
  let eccentricAnomaly = eccentricity < 0.8 ? meanAnomaly : Math.PI;

  for (let i = 0; i < 12; i++) {
    const delta =
      (eccentricAnomaly - eccentricity * Math.sin(eccentricAnomaly) - meanAnomaly) /
      (1 - eccentricity * Math.cos(eccentricAnomaly));
    eccentricAnomaly -= delta;

    if (Math.abs(delta) < 1e-8) {
      break;
    }
  }

  return eccentricAnomaly;
}

function orbitalPlaneToEci(radiusKm, trueAnomaly, tleRecord) {
  const cosRightAscension = Math.cos(tleRecord.rightAscensionRad);
  const sinRightAscension = Math.sin(tleRecord.rightAscensionRad);
  const cosInclination = Math.cos(tleRecord.inclinationRad);
  const sinInclination = Math.sin(tleRecord.inclinationRad);
  const argumentLatitude = tleRecord.argumentOfPerigeeRad + trueAnomaly;
  const cosArgumentLatitude = Math.cos(argumentLatitude);
  const sinArgumentLatitude = Math.sin(argumentLatitude);

  return {
    x:
      radiusKm *
      (cosRightAscension * cosArgumentLatitude -
        sinRightAscension * sinArgumentLatitude * cosInclination),
    y:
      radiusKm *
      (sinRightAscension * cosArgumentLatitude +
        cosRightAscension * sinArgumentLatitude * cosInclination),
    z: radiusKm * (sinArgumentLatitude * sinInclination)
  };
}

function eciToEcef(positionEci, timestamp) {
  const siderealTime = greenwichMeanSiderealTime(timestamp);
  const cosSiderealTime = Math.cos(siderealTime);
  const sinSiderealTime = Math.sin(siderealTime);

  return {
    x: cosSiderealTime * positionEci.x + sinSiderealTime * positionEci.y,
    y: -sinSiderealTime * positionEci.x + cosSiderealTime * positionEci.y,
    z: positionEci.z
  };
}

function greenwichMeanSiderealTime(timestamp) {
  const julianDate = timestamp / MILLISECONDS_PER_DAY + 2440587.5;
  const centuries = (julianDate - 2451545.0) / 36525;
  const siderealDegrees =
    280.46061837 +
    360.98564736629 * (julianDate - 2451545.0) +
    0.000387933 * Math.pow(centuries, 2) -
    Math.pow(centuries, 3) / 38710000;

  return degreesToRadians(normalizeDegrees(siderealDegrees));
}

function normalizeRadians(radians) {
  return ((radians % TWO_PI) + TWO_PI) % TWO_PI;
}

function normalizeDegrees(degrees) {
  return ((degrees % 360) + 360) % 360;
}

function normalizeLongitude(longitude) {
  const normalized = ((((longitude + 180) % 360) + 360) % 360) - 180;

  return normalized === -180 ? 180 : normalized;
}

function degreesToRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function radiansToDegrees(radians) {
  return (radians * 180) / Math.PI;
}
