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

import { createOpenMct, resetApplicationState } from 'utils/testing';

import SatelliteMapPlugin from './plugin.js';

describe('The satellite map plugin', () => {
  let openmct;
  let satelliteMapDefinition;

  beforeEach(() => {
    openmct = createOpenMct();
    openmct.install(SatelliteMapPlugin());
    satelliteMapDefinition = openmct.types.get('satelliteMap').definition;
  });

  afterEach(() => {
    return resetApplicationState(openmct);
  });

  it('registers a creatable satellite map type', () => {
    expect(satelliteMapDefinition.name).toBe('Satellite Map');
    expect(satelliteMapDefinition.creatable).toBeTrue();
    expect(satelliteMapDefinition.cssClass).toBe('icon-map');
  });

  it('initializes default configuration', () => {
    const domainObject = {
      type: 'satelliteMap'
    };

    satelliteMapDefinition.initialize(domainObject);

    expect(domainObject.configuration.tle).toContain('1 25544U');
    expect(domainObject.configuration.trackPastMinutes).toBe(90);
    expect(domainObject.configuration.trackFutureMinutes).toBe(90);
  });

  it('provides a satellite map view', () => {
    const satelliteMapObject = {
      type: 'satelliteMap',
      identifier: {
        namespace: '',
        key: 'satellite-map'
      }
    };
    const applicableViews = openmct.objectViews.get(satelliteMapObject, [satelliteMapObject]);
    const satelliteMapView = applicableViews.find((view) => view.key === 'satellite-map');

    expect(satelliteMapView).toBeDefined();
  });
});
