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

import { SAA_CONTOURS } from './saaContour.js';

export { SAA_CONTOURS } from './saaContour.js';

const EARTH_RADIUS_KM = 6378.137;
const MILLISECONDS_PER_DAY = 86400000;
const JULIAN_UNIX_EPOCH = 2440587.5;
const JULIAN_J2000 = 2451545.0;
const TERMINATOR_STEP_DEGREES = 2;
const ECLIPSE_LATITUDE_STEP_DEGREES = 1;
const ECLIPSE_BOUNDARY_ITERATIONS = 12;
const WEB_MERCATOR_MAX_LATITUDE = 85;

export function enrichTrackPoint(point) {
  const sun = getSunPosition(point.timestamp);
  const sunlit = isSatelliteSunlit(point, sun);
  const inSaa = isInSaa(point.latitude, point.longitude);

  return {
    ...point,
    sunlit,
    inSaa,
    powerOn: !sunlit && !inSaa,
    powerOff: sunlit || inSaa
  };
}

export function getSunPosition(timestamp) {
  const julianDate = timestamp / MILLISECONDS_PER_DAY + JULIAN_UNIX_EPOCH;
  const daysSinceJ2000 = julianDate - JULIAN_J2000;
  const meanLongitude = normalizeDegrees(280.46 + 0.9856474 * daysSinceJ2000);
  const meanAnomaly = degreesToRadians(normalizeDegrees(357.528 + 0.9856003 * daysSinceJ2000));
  const eclipticLongitude = degreesToRadians(
    meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)
  );
  const obliquity = degreesToRadians(23.439 - 0.0000004 * daysSinceJ2000);
  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLongitude),
    Math.cos(eclipticLongitude)
  );
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  const greenwichSiderealTime = degreesToRadians(
    normalizeDegrees(280.46061837 + 360.98564736629 * daysSinceJ2000)
  );
  const subsolarLongitude = normalizeLongitude(
    radiansToDegrees(rightAscension - greenwichSiderealTime)
  );

  return {
    declination,
    latitude: radiansToDegrees(declination),
    longitude: subsolarLongitude
  };
}

export function getNightPolygons(timestamp) {
  const sun = getSunPosition(timestamp);
  const declination = sun.declination;

  if (Math.abs(Math.sin(declination)) < 0.01) {
    return getEquinoxNightPolygons(sun.longitude);
  }

  const terminator = [];

  for (let longitude = -180; longitude <= 180; longitude += TERMINATOR_STEP_DEGREES) {
    const hourAngle = degreesToRadians(normalizeLongitude(longitude - sun.longitude));
    const latitude = radiansToDegrees(
      Math.atan((-Math.cos(declination) * Math.cos(hourAngle)) / Math.sin(declination))
    );
    terminator.push([clampLatitude(latitude), longitude]);
  }

  if (declination > 0) {
    return [[[-WEB_MERCATOR_MAX_LATITUDE, -180], ...terminator, [-WEB_MERCATOR_MAX_LATITUDE, 180]]];
  }

  return [[[WEB_MERCATOR_MAX_LATITUDE, -180], ...terminator, [WEB_MERCATOR_MAX_LATITUDE, 180]]];
}

export function getEclipsePolygons(timestamp, altitudeKm = 0) {
  const sun = getSunPosition(timestamp);
  const eclipseAltitudeKm = Math.max(0, Number(altitudeKm) || 0);
  const angularRadius = Math.asin(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + eclipseAltitudeKm));
  const antiSolarLatitude = -sun.latitude;
  const antiSolarLongitude = normalizeLongitude(sun.longitude + 180);

  return getAngularCapPolygons(antiSolarLatitude, antiSolarLongitude, angularRadius);
}

export function isInSaa(latitude, longitude) {
  return pointInPolygon(latitude, longitude, SAA_CONTOURS[0].points);
}

function isSatelliteSunlit(point, sun) {
  const satelliteVector = toCartesian(point.latitude, point.longitude, point.altitudeKm);
  const sunVector = toUnitVector(sun.latitude, sun.longitude);
  const projection = dot(satelliteVector, sunVector);
  const satelliteDistance = magnitude(satelliteVector);
  const perpendicularDistance = Math.sqrt(
    Math.max(0, satelliteDistance * satelliteDistance - projection * projection)
  );
  const inUmbra = projection < 0 && perpendicularDistance < EARTH_RADIUS_KM;

  return !inUmbra;
}

function getEquinoxNightPolygons(subsolarLongitude) {
  const antiSolarLongitude = normalizeLongitude(subsolarLongitude + 180);
  const west = normalizeLongitude(antiSolarLongitude - 90);
  const east = normalizeLongitude(antiSolarLongitude + 90);

  if (west <= east) {
    return [longitudeBandPolygon(west, east)];
  }

  return [longitudeBandPolygon(west, 180), longitudeBandPolygon(-180, east)];
}

function longitudeBandPolygon(west, east) {
  return [
    [-WEB_MERCATOR_MAX_LATITUDE, west],
    [WEB_MERCATOR_MAX_LATITUDE, west],
    [WEB_MERCATOR_MAX_LATITUDE, east],
    [-WEB_MERCATOR_MAX_LATITUDE, east]
  ];
}

function getAngularCapPolygons(centerLatitude, centerLongitude, angularRadius) {
  const latitudeIntervals = [];

  for (let longitude = -180; longitude <= 180; longitude += TERMINATOR_STEP_DEGREES) {
    const interval = latitudeIntervalForAngularCap(
      longitude,
      centerLatitude,
      centerLongitude,
      angularRadius
    );

    latitudeIntervals.push(
      interval && {
        ...interval,
        longitude
      }
    );
  }

  const intervalRanges = [];
  let currentRange = [];

  latitudeIntervals.forEach((interval) => {
    if (interval) {
      currentRange.push(interval);

      return;
    }

    if (currentRange.length > 1) {
      intervalRanges.push(currentRange);
    }

    currentRange = [];
  });

  if (currentRange.length > 1) {
    intervalRanges.push(currentRange);
  }

  return intervalRanges.map((range) => [
    ...range.map((interval) => [interval.minimumLatitude, interval.longitude]),
    ...range
      .slice()
      .reverse()
      .map((interval) => [interval.maximumLatitude, interval.longitude])
  ]);
}

function latitudeIntervalForAngularCap(longitude, centerLatitude, centerLongitude, angularRadius) {
  const centerLatitudeRadians = degreesToRadians(centerLatitude);
  const centerLongitudeRadians = degreesToRadians(centerLongitude);
  const radiusCosine = Math.cos(angularRadius);
  let previousLatitude = -WEB_MERCATOR_MAX_LATITUDE;
  let previousInside = isInsideAngularCap(
    previousLatitude,
    longitude,
    centerLatitudeRadians,
    centerLongitudeRadians,
    radiusCosine
  );
  let minimumLatitude = previousInside ? previousLatitude : undefined;

  for (
    let latitude = previousLatitude + ECLIPSE_LATITUDE_STEP_DEGREES;
    latitude <= WEB_MERCATOR_MAX_LATITUDE;
    latitude += ECLIPSE_LATITUDE_STEP_DEGREES
  ) {
    const currentLatitude = Math.min(latitude, WEB_MERCATOR_MAX_LATITUDE);
    const currentInside = isInsideAngularCap(
      currentLatitude,
      longitude,
      centerLatitudeRadians,
      centerLongitudeRadians,
      radiusCosine
    );

    if (previousInside !== currentInside) {
      const boundaryLatitude = findAngularCapBoundary(
        previousLatitude,
        currentLatitude,
        longitude,
        centerLatitudeRadians,
        centerLongitudeRadians,
        radiusCosine
      );

      if (currentInside) {
        minimumLatitude = boundaryLatitude;
      } else {
        return {
          minimumLatitude: minimumLatitude ?? -WEB_MERCATOR_MAX_LATITUDE,
          maximumLatitude: boundaryLatitude
        };
      }
    }

    previousLatitude = currentLatitude;
    previousInside = currentInside;
  }

  if (previousInside) {
    return {
      minimumLatitude: minimumLatitude ?? -WEB_MERCATOR_MAX_LATITUDE,
      maximumLatitude: WEB_MERCATOR_MAX_LATITUDE
    };
  }

  return undefined;
}

function findAngularCapBoundary(
  lowerLatitude,
  upperLatitude,
  longitude,
  centerLatitudeRadians,
  centerLongitudeRadians,
  radiusCosine
) {
  let lower = lowerLatitude;
  let upper = upperLatitude;

  for (let iteration = 0; iteration < ECLIPSE_BOUNDARY_ITERATIONS; iteration++) {
    const midpoint = (lower + upper) / 2;
    const lowerInside = isInsideAngularCap(
      lower,
      longitude,
      centerLatitudeRadians,
      centerLongitudeRadians,
      radiusCosine
    );
    const midpointInside = isInsideAngularCap(
      midpoint,
      longitude,
      centerLatitudeRadians,
      centerLongitudeRadians,
      radiusCosine
    );

    if (lowerInside === midpointInside) {
      lower = midpoint;
    } else {
      upper = midpoint;
    }
  }

  return (lower + upper) / 2;
}

function isInsideAngularCap(
  latitude,
  longitude,
  centerLatitudeRadians,
  centerLongitudeRadians,
  radiusCosine
) {
  const latitudeRadians = degreesToRadians(latitude);
  const longitudeRadians = degreesToRadians(longitude);
  const longitudeDelta = longitudeRadians - centerLongitudeRadians;
  const angularDistanceCosine =
    Math.sin(latitudeRadians) * Math.sin(centerLatitudeRadians) +
    Math.cos(latitudeRadians) * Math.cos(centerLatitudeRadians) * Math.cos(longitudeDelta);

  return angularDistanceCosine >= radiusCosine;
}

function toCartesian(latitude, longitude, altitudeKm) {
  const radius = EARTH_RADIUS_KM + altitudeKm;
  const latitudeRad = degreesToRadians(latitude);
  const longitudeRad = degreesToRadians(longitude);
  const cosLatitude = Math.cos(latitudeRad);

  return {
    x: radius * cosLatitude * Math.cos(longitudeRad),
    y: radius * cosLatitude * Math.sin(longitudeRad),
    z: radius * Math.sin(latitudeRad)
  };
}

function toUnitVector(latitude, longitude) {
  const latitudeRad = degreesToRadians(latitude);
  const longitudeRad = degreesToRadians(longitude);
  const cosLatitude = Math.cos(latitudeRad);

  return {
    x: cosLatitude * Math.cos(longitudeRad),
    y: cosLatitude * Math.sin(longitudeRad),
    z: Math.sin(latitudeRad)
  };
}

function pointInPolygon(latitude, longitude, polygon) {
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [latitudeI, longitudeI] = polygon[i];
    const [latitudeJ, longitudeJ] = polygon[j];
    const intersects =
      longitudeI > longitude !== longitudeJ > longitude &&
      latitude <
        ((latitudeJ - latitudeI) * (longitude - longitudeI)) / (longitudeJ - longitudeI) +
          latitudeI;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function clampLatitude(latitude) {
  return Math.min(WEB_MERCATOR_MAX_LATITUDE, Math.max(-WEB_MERCATOR_MAX_LATITUDE, latitude));
}

function dot(vectorA, vectorB) {
  return vectorA.x * vectorB.x + vectorA.y * vectorB.y + vectorA.z * vectorB.z;
}

function magnitude(vector) {
  return Math.hypot(vector.x, vector.y, vector.z);
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
