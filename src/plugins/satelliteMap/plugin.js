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

import SatelliteMapViewProvider from './SatelliteMapViewProvider.js';
import { DEFAULT_SATELLITE_MAP_CONFIGURATION, normalizeConfiguration } from './satelliteMath.js';

const SATELLITE_MAP_TYPE = 'satelliteMap';

export default function SatelliteMapPlugin() {
  return function install(openmct) {
    openmct.objectViews.addProvider(new SatelliteMapViewProvider(openmct));

    openmct.types.addType(SATELLITE_MAP_TYPE, {
      name: 'Satellite Map',
      description:
        'Display a satellite position and ground track on a Leaflet satellite imagery map from a two-line element set.',
      creatable: true,
      cssClass: 'icon-map',
      initialize(domainObject) {
        domainObject.configuration = {
          ...DEFAULT_SATELLITE_MAP_CONFIGURATION
        };
      },
      form: [
        {
          key: 'tle',
          name: 'Two-Line Element Set',
          control: 'textarea',
          required: true,
          cssClass: 'l-input-lg',
          property: ['configuration', 'tle']
        },
        {
          key: 'trackPastMinutes',
          name: 'Track Past Minutes',
          control: 'numberfield',
          min: 0,
          max: 1440,
          step: 1,
          cssClass: 'l-input-sm',
          property: ['configuration', 'trackPastMinutes']
        },
        {
          key: 'trackFutureMinutes',
          name: 'Track Future Minutes',
          control: 'numberfield',
          min: 0,
          max: 1440,
          step: 1,
          cssClass: 'l-input-sm',
          property: ['configuration', 'trackFutureMinutes']
        },
        {
          key: 'sampleMinutes',
          name: 'Sample Minutes',
          control: 'numberfield',
          min: 0.25,
          max: 60,
          step: 0.25,
          cssClass: 'l-input-sm',
          property: ['configuration', 'sampleMinutes']
        },
        {
          key: 'refreshSeconds',
          name: 'Refresh Seconds',
          control: 'numberfield',
          min: 1,
          max: 3600,
          step: 1,
          cssClass: 'l-input-sm',
          property: ['configuration', 'refreshSeconds']
        },
        {
          key: 'showGrid',
          name: 'Show Grid',
          control: 'toggleSwitch',
          cssClass: 'l-input',
          property: ['configuration', 'showGrid']
        }
      ]
    });

    openmct.objects.addGetInterceptor({
      appliesTo(identifier, domainObject) {
        return domainObject?.type === SATELLITE_MAP_TYPE;
      },
      invoke(identifier, domainObject) {
        const normalizedConfiguration = normalizeConfiguration(domainObject.configuration);

        domainObject.configuration = normalizedConfiguration;

        return domainObject;
      }
    });
  };
}
