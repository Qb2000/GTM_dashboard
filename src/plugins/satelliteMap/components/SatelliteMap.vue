<!--
 Open MCT, Copyright (c) 2014-2024, United States Government
 as represented by the Administrator of the National Aeronautics and Space
 Administration. All rights reserved.

 Open MCT is licensed under the Apache License, Version 2.0 (the
 "License"); you may not use this file except in compliance with the License.
 You may obtain a copy of the License at
 http://www.apache.org/licenses/LICENSE-2.0.

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 License for the specific language governing permissions and limitations
 under the License.

 Open MCT includes source code licensed under additional open source
 licenses. See the Open Source Licenses file (LICENSES.md) included with
 this source code distribution or the Licensing information page available
 at runtime from the About dialog for additional information.
-->

<template>
  <div class="c-satellite-map abs">
    <div ref="map" class="c-satellite-map__leaflet" :aria-label="mapAriaLabel"></div>
    <div class="c-satellite-map__hud">
      <div class="c-satellite-map__title">{{ satelliteName }}</div>
      <div class="c-satellite-map__metric">
        <span>Lat</span>
        <strong>{{ latitudeText }}</strong>
      </div>
      <div class="c-satellite-map__metric">
        <span>Lon</span>
        <strong>{{ longitudeText }}</strong>
      </div>
      <div class="c-satellite-map__metric">
        <span>Alt</span>
        <strong>{{ altitudeText }}</strong>
      </div>
      <div class="c-satellite-map__metric">
        <span>State</span>
        <strong>{{ environmentText }}</strong>
      </div>
      <div class="c-satellite-map__metric">
        <span>Sunlit</span>
        <strong>{{ sunlitDurationText }}</strong>
      </div>
      <div class="c-satellite-map__metric">
        <span>SAA</span>
        <strong>{{ saaDurationText }}</strong>
      </div>
      <div class="c-satellite-map__metric">
        <span>Power-on</span>
        <strong>{{ powerOnDurationText }}</strong>
      </div>
    </div>
    <div v-if="displayError" class="c-satellite-map__error" role="alert">
      {{ displayError }}
    </div>
  </div>
</template>

<script>
// cspell:words Geographics Maxar
import {
  generateGroundTrack,
  normalizeConfiguration,
  parseTle,
  propagateTle
} from '../satelliteMath.js';
import { enrichTrackPoint, getEclipsePolygons, SAA_CONTOURS } from '../spaceEnvironment.js';

const ESRI_WORLD_IMAGERY_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_ATTRIBUTION =
  'Tiles &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community';
const DEFAULT_CENTER = [0, 0];
const DEFAULT_ZOOM = 2;
const MAX_ZOOM = 18;
const POWER_ON_COLOR = '#40c4ff';
const POWER_OFF_COLOR = '#ff1744';
const EARTH_RADIUS_KM = 6378.137;
const POWER_STATE_BOUNDARY_ITERATIONS = 12;

export default {
  inject: ['openmct', 'domainObject'],
  data() {
    return {
      configuration: normalizeConfiguration(this.domainObject.configuration),
      position: undefined,
      satelliteName: 'Satellite',
      pastTrack: [],
      futureTrack: [],
      orbitErrorMessage: '',
      mapErrorMessage: '',
      hasCenteredMap: false,
      renderTimestamp: Date.now(),
      sunlitDurationMs: 0,
      saaDurationMs: 0,
      powerOnDurationMs: 0
    };
  },
  computed: {
    latitudeText() {
      return this.position ? `${this.position.latitude.toFixed(3)} deg` : '--';
    },
    longitudeText() {
      return this.position ? `${this.position.longitude.toFixed(3)} deg` : '--';
    },
    altitudeText() {
      return this.position ? `${Math.round(this.position.altitudeKm)} km` : '--';
    },
    sunlitDurationText() {
      return this.formatDuration(this.sunlitDurationMs);
    },
    saaDurationText() {
      return this.formatDuration(this.saaDurationMs);
    },
    powerOnDurationText() {
      return this.formatDuration(this.powerOnDurationMs);
    },
    environmentText() {
      if (!this.position) {
        return '--';
      }

      if (this.position.inSaa) {
        return this.position.sunlit ? 'SAA, sunlit' : 'SAA, eclipse';
      }

      return this.position.sunlit ? 'Sunlit' : 'Eclipse';
    },
    displayError() {
      return this.mapErrorMessage || this.orbitErrorMessage;
    },
    mapAriaLabel() {
      if (this.displayError) {
        return `Satellite imagery map error: ${this.displayError}`;
      }

      return `Satellite imagery map for ${this.satelliteName}. Latitude ${this.latitudeText}. Longitude ${this.longitudeText}. Altitude ${this.altitudeText}. State ${this.environmentText}.`;
    }
  },
  mounted() {
    this.initializeMap();
    this.unobserveConfiguration = this.openmct.objects.observe(
      this.domainObject,
      'configuration',
      this.updateConfiguration
    );

    this.resizeObserver = new ResizeObserver(this.invalidateMapSize);
    this.resizeObserver.observe(this.$el);
    this.handleBoundsChanged = this.handleBoundsChanged.bind(this);
    this.handleTimeChanged = this.handleTimeChanged.bind(this);
    this.openmct.time.on('boundsChanged', this.handleBoundsChanged);
    this.openmct.time.on('modeChanged', this.handleTimeChanged);
    this.openmct.time.on('timeOfInterest', this.handleTimeChanged);
    this.updateOrbit();
    this.startRefreshTimer();
  },
  beforeUnmount() {
    if (this.unobserveConfiguration) {
      this.unobserveConfiguration();
    }

    if (this.refreshTimer) {
      window.clearInterval(this.refreshTimer);
    }

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }

    this.openmct.time.off('boundsChanged', this.handleBoundsChanged);
    this.openmct.time.off('modeChanged', this.handleTimeChanged);
    this.openmct.time.off('timeOfInterest', this.handleTimeChanged);

    if (this.leafletMap) {
      this.leafletMap.remove();
    }
  },
  methods: {
    initializeMap() {
      const leaflet = window.L;

      if (!leaflet) {
        this.mapErrorMessage =
          'Leaflet is unavailable. Check the Leaflet CDN scripts in index.html.';

        return;
      }

      this.leafletMap = leaflet.map(this.$refs.map, {
        attributionControl: true,
        center: DEFAULT_CENTER,
        maxBounds: [
          [-85, -180],
          [85, 180]
        ],
        maxBoundsViscosity: 1,
        maxZoom: MAX_ZOOM,
        minZoom: 2,
        zoom: DEFAULT_ZOOM
      });

      leaflet
        .tileLayer(ESRI_WORLD_IMAGERY_URL, {
          attribution: ESRI_ATTRIBUTION,
          maxZoom: MAX_ZOOM,
          noWrap: true
        })
        .addTo(this.leafletMap);

      this.shadowLayer = leaflet.layerGroup().addTo(this.leafletMap);
      this.saaLayer = leaflet.layerGroup().addTo(this.leafletMap);
      this.gridLayer = leaflet.layerGroup().addTo(this.leafletMap);
      this.trackLayer = leaflet.layerGroup().addTo(this.leafletMap);
      this.positionLayer = leaflet.layerGroup().addTo(this.leafletMap);
      this.drawSaaContours();
      this.drawGrid();
      this.mapErrorMessage = '';
    },
    updateConfiguration(configuration) {
      this.configuration = normalizeConfiguration(configuration);
      this.drawGrid();
      this.updateOrbit();
      this.startRefreshTimer();
    },
    startRefreshTimer() {
      if (this.refreshTimer) {
        window.clearInterval(this.refreshTimer);
      }

      this.refreshTimer = window.setInterval(
        this.updateOrbit,
        this.configuration.refreshSeconds * 1000
      );
    },
    handleBoundsChanged(bounds, isTick) {
      if (!isTick) {
        this.updateOrbit();
      }
    },
    handleTimeChanged() {
      this.updateOrbit();
    },
    updateOrbit() {
      try {
        const tleRecord = parseTle(this.configuration.tle);
        const centerTimestamp = this.currentTimestamp();
        const groundTrack = generateGroundTrack(
          tleRecord,
          centerTimestamp,
          this.configuration.trackPastMinutes,
          this.configuration.trackFutureMinutes,
          this.configuration.sampleMinutes
        );
        const enrichedGroundTrack = this.refinePowerStateTransitions(
          groundTrack.map(enrichTrackPoint),
          tleRecord
        );
        const orbitDurationMinutes = (Math.PI * 2) / tleRecord.meanMotionRadPerSecond / 60;
        const currentOrbitTrack = generateGroundTrack(
          tleRecord,
          centerTimestamp,
          orbitDurationMinutes / 2,
          orbitDurationMinutes / 2,
          Math.min(this.configuration.sampleMinutes, 1)
        ).map(enrichTrackPoint);

        this.satelliteName = tleRecord.name;
        this.renderTimestamp = centerTimestamp;
        this.position = enrichTrackPoint(propagateTle(tleRecord, centerTimestamp));
        this.pastTrack = enrichedGroundTrack.filter((point) => point.timestamp <= centerTimestamp);
        this.futureTrack = enrichedGroundTrack.filter(
          (point) => point.timestamp >= centerTimestamp
        );
        this.sunlitDurationMs = this.totalDurationFor(currentOrbitTrack, 'sunlit');
        this.saaDurationMs = this.totalDurationFor(currentOrbitTrack, 'inSaa');
        this.powerOnDurationMs = this.totalDurationFor(currentOrbitTrack, 'powerOn');
        this.orbitErrorMessage = '';
      } catch (error) {
        this.position = undefined;
        this.pastTrack = [];
        this.futureTrack = [];
        this.sunlitDurationMs = 0;
        this.saaDurationMs = 0;
        this.powerOnDurationMs = 0;
        this.orbitErrorMessage = error.message;
      }

      this.updateMapLayers();
    },
    currentTimestamp() {
      const timeOfInterest = this.openmct.time.timeOfInterest?.();

      if (Number.isFinite(timeOfInterest)) {
        return timeOfInterest;
      }

      const mode = this.openmct.time.getMode?.();

      if (mode === 'fixed') {
        const bounds = this.openmct.time.getBounds?.() ?? this.openmct.time.bounds?.();

        if (Number.isFinite(bounds?.end)) {
          return bounds.end;
        }
      }

      const timestamp = this.openmct.time.now();

      return Number.isFinite(timestamp) ? timestamp : Date.now();
    },
    updateMapLayers() {
      if (!this.leafletMap || !window.L) {
        return;
      }

      this.shadowLayer.clearLayers();
      this.trackLayer.clearLayers();
      this.positionLayer.clearLayers();

      this.drawEclipseShadow();
      this.drawTrack(this.pastTrack);
      this.drawTrack(this.futureTrack);
      this.drawSatellite();

      if (this.position && !this.hasCenteredMap) {
        this.leafletMap.setView([this.position.latitude, this.position.longitude], DEFAULT_ZOOM);
        this.hasCenteredMap = true;
      }
    },
    drawEclipseShadow() {
      const eclipseAltitudeKm = this.position?.altitudeKm ?? 0;

      getEclipsePolygons(this.renderTimestamp, eclipseAltitudeKm).forEach((polygon) => {
        window.L.polygon(polygon, {
          color: '#000000',
          fillColor: '#000000',
          fillOpacity: 0.42,
          interactive: false,
          opacity: 0,
          stroke: false
        }).addTo(this.shadowLayer);
      });
    },
    drawSaaContours() {
      if (!this.saaLayer || !window.L) {
        return;
      }

      this.saaLayer.clearLayers();

      SAA_CONTOURS.forEach((contour) => {
        window.L.polygon(contour.points, {
          color: contour.color,
          dashArray: '6 4',
          fillColor: contour.color,
          fillOpacity: contour.fillOpacity,
          interactive: false,
          opacity: 0.95,
          weight: 2
        }).addTo(this.saaLayer);
      });
    },
    drawTrack(points) {
      this.splitAtDateline(points).forEach((segment) => {
        if (segment.length < 2) {
          return;
        }

        this.splitAtEnvironmentChanges(segment).forEach((trackSegment) => {
          if (trackSegment.points.length < 2) {
            return;
          }

          window.L.polyline(
            trackSegment.points.map((point) => [point.latitude, point.longitude]),
            {
              color: trackSegment.powerOn ? POWER_ON_COLOR : POWER_OFF_COLOR,
              interactive: false,
              opacity: 0.95,
              weight: 3
            }
          ).addTo(this.trackLayer);
        });
      });
    },
    drawSatellite() {
      if (!this.position) {
        return;
      }

      const latitudeLongitude = [this.position.latitude, this.position.longitude];

      window.L.circle(latitudeLongitude, {
        color: this.position.powerOn ? POWER_ON_COLOR : POWER_OFF_COLOR,
        fillColor: this.position.powerOn ? POWER_ON_COLOR : POWER_OFF_COLOR,
        fillOpacity: 0.08,
        interactive: false,
        opacity: 0.28,
        radius: this.footprintRadiusMeters(this.position.altitudeKm),
        weight: 1
      }).addTo(this.positionLayer);

      window.L.circleMarker(latitudeLongitude, {
        color: '#ffffff',
        fillColor: this.position.powerOn ? POWER_ON_COLOR : POWER_OFF_COLOR,
        fillOpacity: 1,
        radius: 7,
        weight: 3
      })
        .bindTooltip(this.satelliteName, {
          direction: 'top',
          offset: [0, -8],
          opacity: 0.92,
          permanent: false
        })
        .addTo(this.positionLayer);
    },
    drawGrid() {
      if (!this.gridLayer || !window.L) {
        return;
      }

      this.gridLayer.clearLayers();

      if (!this.configuration.showGrid) {
        return;
      }

      for (let longitude = -180; longitude <= 180; longitude += 30) {
        window.L.polyline(
          [
            [-85, longitude],
            [85, longitude]
          ],
          this.gridStyle()
        ).addTo(this.gridLayer);
      }

      for (let latitude = -60; latitude <= 60; latitude += 30) {
        window.L.polyline(
          [
            [latitude, -180],
            [latitude, 180]
          ],
          this.gridStyle()
        ).addTo(this.gridLayer);
      }
    },
    gridStyle() {
      return {
        color: '#ffffff',
        interactive: false,
        opacity: 0.2,
        weight: 1
      };
    },
    footprintRadiusMeters(altitudeKm) {
      const centralAngle = Math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + altitudeKm));

      return EARTH_RADIUS_KM * centralAngle * 1000;
    },
    splitAtDateline(points) {
      const segments = [];
      let currentSegment = [];

      points.forEach((point) => {
        const previousPoint = currentSegment[currentSegment.length - 1];

        if (previousPoint && Math.abs(point.longitude - previousPoint.longitude) > 180) {
          segments.push(currentSegment);
          currentSegment = [];
        }

        currentSegment.push(point);
      });

      if (currentSegment.length > 0) {
        segments.push(currentSegment);
      }

      return segments;
    },
    totalDurationFor(points, property) {
      let duration = 0;

      for (let index = 1; index < points.length; index++) {
        const previousPoint = points[index - 1];
        const point = points[index];
        const activeFraction = (Number(previousPoint[property]) + Number(point[property])) / 2;

        duration += (point.timestamp - previousPoint.timestamp) * activeFraction;
      }

      return duration;
    },
    totalDurationWhere(points, predicate) {
      let duration = 0;

      for (let index = 1; index < points.length; index++) {
        const previousPoint = points[index - 1];
        const point = points[index];
        const activeFraction = (Number(predicate(previousPoint)) + Number(predicate(point))) / 2;

        duration += (point.timestamp - previousPoint.timestamp) * activeFraction;
      }

      return duration;
    },
    refinePowerStateTransitions(points, tleRecord) {
      if (points.length < 2) {
        return points;
      }

      const refinedPoints = [points[0]];

      for (let index = 1; index < points.length; index++) {
        const previousPoint = points[index - 1];
        const point = points[index];

        if (previousPoint.powerOn !== point.powerOn) {
          const boundaryPoint = this.findPowerStateBoundary(tleRecord, previousPoint, point);

          refinedPoints.push(
            this.withPowerState(boundaryPoint, previousPoint.powerOn),
            this.withPowerState(boundaryPoint, point.powerOn)
          );
        }

        refinedPoints.push(point);
      }

      return refinedPoints;
    },
    findPowerStateBoundary(tleRecord, startPoint, endPoint) {
      const startPowerOn = startPoint.powerOn;
      let lowerTimestamp = startPoint.timestamp;
      let upperTimestamp = endPoint.timestamp;

      for (let iteration = 0; iteration < POWER_STATE_BOUNDARY_ITERATIONS; iteration++) {
        const midpointTimestamp = (lowerTimestamp + upperTimestamp) / 2;
        const midpoint = enrichTrackPoint(propagateTle(tleRecord, midpointTimestamp));

        if (midpoint.powerOn === startPowerOn) {
          lowerTimestamp = midpointTimestamp;
        } else {
          upperTimestamp = midpointTimestamp;
        }
      }

      return enrichTrackPoint(propagateTle(tleRecord, (lowerTimestamp + upperTimestamp) / 2));
    },
    withPowerState(point, powerOn) {
      return {
        ...point,
        powerOn,
        powerOff: !powerOn
      };
    },
    formatDuration(durationMs) {
      const totalMinutes = Math.round(durationMs / 60000);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;

      if (hours > 0) {
        return `${hours}h ${minutes}m`;
      }

      return `${minutes}m`;
    },
    splitAtEnvironmentChanges(segment) {
      const trackSegments = [];
      let currentPowerOn = segment[0].powerOn;
      let currentSegment = [segment[0]];

      for (let index = 1; index < segment.length; index++) {
        const point = segment[index];

        if (point.powerOn !== currentPowerOn) {
          if (currentSegment.length > 1) {
            trackSegments.push({
              points: currentSegment,
              powerOn: currentPowerOn
            });
          }

          currentPowerOn = point.powerOn;
          currentSegment = [point];
        } else {
          currentSegment.push(point);
        }
      }

      if (currentSegment.length > 1) {
        trackSegments.push({
          points: currentSegment,
          powerOn: currentPowerOn
        });
      }

      return trackSegments;
    },
    invalidateMapSize() {
      if (!this.leafletMap) {
        return;
      }

      window.requestAnimationFrame(() => {
        this.leafletMap.invalidateSize();
      });
    }
  }
};
</script>

<style scoped>
.c-satellite-map {
  background: #070b0f;
  color: #f5f7fa;
  contain: layout paint;
  isolation: isolate;
  overflow: hidden;
  z-index: 0;
}

.c-satellite-map__leaflet {
  inset: 0;
  position: absolute;
  z-index: 0;
}

.c-satellite-map__hud {
  background: rgba(7, 10, 13, 0.84);
  border: 1px solid rgba(255, 255, 255, 0.24);
  border-radius: 4px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  display: grid;
  gap: 6px;
  min-width: 190px;
  padding: 10px 12px;
  pointer-events: none;
  position: absolute;
  right: 12px;
  top: 12px;
  z-index: 2;
}

.c-satellite-map__title {
  color: #ffffff;
  font-size: 13px;
  font-weight: 700;
  line-height: 1.2;
}

.c-satellite-map__metric {
  align-items: baseline;
  display: flex;
  font-size: 12px;
  gap: 10px;
  justify-content: space-between;
  line-height: 1.2;
}

.c-satellite-map__metric span {
  color: rgba(245, 247, 250, 0.66);
}

.c-satellite-map__metric strong {
  color: #ffffff;
  font-weight: 600;
}

.c-satellite-map__error {
  background: rgba(82, 31, 31, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 4px;
  bottom: 12px;
  color: #ffffff;
  left: 12px;
  max-width: min(420px, calc(100% - 24px));
  padding: 10px 12px;
  position: absolute;
  z-index: 3;
}
</style>
