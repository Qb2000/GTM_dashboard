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
  DEFAULT_TLE,
  generateGroundTrack,
  normalizeConfiguration,
  parseTle,
  propagateTle
} from './satelliteMath.js';

describe('Satellite map orbital utilities', () => {
  it('parses a two-line element set', () => {
    const tleRecord = parseTle(DEFAULT_TLE);

    expect(tleRecord.name).toBe('ISS');
    expect(tleRecord.eccentricity).toBeCloseTo(0.0004377, 7);
    expect(tleRecord.meanMotionRadPerSecond).toBeGreaterThan(0);
  });

  it('propagates a bounded sub-satellite position', () => {
    const tleRecord = parseTle(DEFAULT_TLE);
    const position = propagateTle(tleRecord, tleRecord.epochMs);

    expect(position.latitude).toBeGreaterThan(-52);
    expect(position.latitude).toBeLessThan(52);
    expect(position.longitude).toBeGreaterThanOrEqual(-180);
    expect(position.longitude).toBeLessThanOrEqual(180);
    expect(position.altitudeKm).toBeGreaterThan(350);
    expect(position.altitudeKm).toBeLessThan(500);
  });

  it('generates a sampled ground track around the center time', () => {
    const tleRecord = parseTle(DEFAULT_TLE);
    const track = generateGroundTrack(tleRecord, tleRecord.epochMs, 30, 30, 10);

    expect(track.length).toBe(7);
    expect(track[0].timestamp).toBe(tleRecord.epochMs - 30 * 60000);
    expect(track[track.length - 1].timestamp).toBe(tleRecord.epochMs + 30 * 60000);
  });

  it('normalizes numeric configuration values', () => {
    const configuration = normalizeConfiguration({
      trackPastMinutes: '-10',
      trackFutureMinutes: '2000',
      sampleMinutes: '0',
      refreshSeconds: '0',
      showGrid: false
    });

    expect(configuration.trackPastMinutes).toBe(0);
    expect(configuration.trackFutureMinutes).toBe(1440);
    expect(configuration.sampleMinutes).toBe(0.25);
    expect(configuration.refreshSeconds).toBe(1);
    expect(configuration.showGrid).toBeFalse();
  });
});
