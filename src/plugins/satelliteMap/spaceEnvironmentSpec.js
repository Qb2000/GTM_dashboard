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

import {
  enrichTrackPoint,
  getEclipsePolygons,
  getNightPolygons,
  getSunPosition,
  isInSaa,
  SAA_CONTOURS
} from './spaceEnvironment.js';

describe('Satellite map space environment utilities', () => {
  it('reports a South Atlantic point inside the AP9 shutdown contour', () => {
    expect(isInSaa(-22.3, -59.6)).toBeTrue();
  });

  it('reports points beyond the AP9 contour as outside the SAA', () => {
    expect(isInSaa(30, 120)).toBeFalse();
    expect(isInSaa(-9, -55)).toBeFalse();
    expect(isInSaa(-43, -50)).toBeFalse();
  });

  it('defines the SAA from the AP9 >10 MeV, 1000 flux contour', () => {
    const [contour] = SAA_CONTOURS;

    expect(SAA_CONTOURS.length).toBe(1);
    expect(contour.model).toBe('AP9');
    expect(contour.particle).toBe('proton');
    expect(contour.energyThresholdMev).toBe(10);
    expect(contour.fluxThreshold).toBe(1000);
    expect(contour.fluxUnit).toBe('cm^-2 s^-1');
    expect(contour.altitudeKm).toBe(561);
    expect(contour.epochMjd).toBe(61041);
    expect(contour.gridStepDegrees).toBe(1);
    expect(contour.points.length).toBe(173);
    expect(contour.points[0]).toEqual(contour.points[contour.points.length - 1]);
  });

  it('computes a subsolar point and a night polygon', () => {
    const timestamp = Date.UTC(2026, 0, 1, 0, 0, 0);
    const sun = getSunPosition(timestamp);
    const nightPolygons = getNightPolygons(timestamp);

    expect(sun.latitude).toBeGreaterThan(-24);
    expect(sun.latitude).toBeLessThan(24);
    expect(sun.longitude).toBeGreaterThanOrEqual(-180);
    expect(sun.longitude).toBeLessThanOrEqual(180);
    expect(nightPolygons.length).toBeGreaterThan(0);
    expect(nightPolygons[0].length).toBeGreaterThan(4);
  });

  it('computes a satellite-altitude eclipse polygon', () => {
    const timestamp = Date.UTC(2026, 0, 1, 0, 0, 0);
    const groundNightPolygons = getNightPolygons(timestamp);
    const satelliteEclipsePolygons = getEclipsePolygons(timestamp, 500);

    expect(satelliteEclipsePolygons.length).toBeGreaterThan(0);
    expect(satelliteEclipsePolygons[0].length).toBeGreaterThan(4);
    expect(satelliteEclipsePolygons[0].length).toBeLessThan(groundNightPolygons[0].length);
  });

  it('marks track points in the SAA as powered off', () => {
    const enrichedPoint = enrichTrackPoint({
      altitudeKm: 500,
      latitude: -22.3,
      longitude: -59.6,
      timestamp: Date.UTC(2026, 0, 1, 0, 0, 0)
    });

    expect(enrichedPoint.inSaa).toBeTrue();
    expect(enrichedPoint.powerOn).toBeFalse();
    expect(enrichedPoint.powerOff).toBeTrue();
  });
});
