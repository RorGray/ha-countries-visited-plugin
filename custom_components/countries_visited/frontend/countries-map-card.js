// Card version
const CARD_VERSION = '0.2';
const DOMAIN = 'countries_visited';

// Dynamic import for map-data.js with version tag
async function loadMapDataModule() {
  const moduleBaseUrl = new URL('.', import.meta.url);
  const mapDataUrl = new URL('map-data.js', moduleBaseUrl);
  const mapDataPaths = [
    `/hacsfiles/countries-visited/map-data.js?v=${CARD_VERSION}`,
    `${mapDataUrl.href}?v=${CARD_VERSION}`
  ];

  // Try each path until one succeeds
  for (const path of mapDataPaths) {
    try {
      const module = await import(path);
      return module;
    } catch (error) {
      // Try next path
      continue;
    }
  }

  // Fallback to relative import without version (for development)
  return import('./map-data.js');
}

// Styled console logging helper
const logStyle = {
  info: 'color: #4CAF50; font-weight: bold;',
  warn: 'color: #FF9800; font-weight: bold;',
  error: 'color: #F44336; font-weight: bold;',
  debug: 'color: #2196F3; font-weight: bold;',
  version: 'color: #2196F3; font-weight: bold; background: #E3F2FD; padding: 2px 6px; border-radius: 3px;',
};

function logInfo(message, ...args) {
  console.log(`%c🌍 Countries Visited ${message}`, logStyle.info, ...args);
}

function logWarn(message, ...args) {
  console.warn(`%c🌍 Countries Visited ${message}`, logStyle.warn, ...args);
}

function logError(message, ...args) {
  console.error(`%c🌍 Countries Visited ${message}`, logStyle.error, ...args);
}

function logDebug(message, ...args) {
  if (console.debug) {
    console.debug(`%c🌍 Countries Visited ${message}`, logStyle.debug, ...args);
  }
}

function logVersion() {
  console.log(`%c🌍 Countries Visited Card v${CARD_VERSION}`, logStyle.version);
}

// Track if we've already logged sensor finding errors to avoid spam
let _sensorErrorLogged = new Set();
let _sensorErrorThrown = new Set(); // Track thrown errors to prevent duplicates
let _versionLogged = false;

// CSS loading state (module-level, shared across all card instances)
let _cssLoading = false;
let _cssLoaded = false;
let _cssLoadPromise = null;
let _cssText = null; // Store CSS text once loaded

// Module-level CSS loading function (shared across all card instances)
function loadCardCSS() {
  // If already loaded, return immediately
  if (_cssLoaded && _cssText) {
    return Promise.resolve(_cssText);
  }

  // If currently loading, return the existing promise
  if (_cssLoading && _cssLoadPromise) {
    return _cssLoadPromise;
  }

  // Start loading
  _cssLoading = true;

  _cssLoadPromise = new Promise(async (resolve, reject) => {
    // Try HACS path first, then module-relative fallback
    const moduleBaseUrl = new URL('.', import.meta.url);
    const cssUrl = new URL('countries-map-card.css', moduleBaseUrl);
    const cssPaths = [
      `/hacsfiles/countries-visited/countries-map-card.css?v=${CARD_VERSION}`,
      `${cssUrl.href}?v=${CARD_VERSION}`
    ];

    let cssText = null;
    let lastError = null;

    // Try each path until one succeeds
    for (const path of cssPaths) {
      try {
        const response = await fetch(path);
        if (response.ok) {
          cssText = await response.text();
          break; // Success, exit loop
        } else {
          lastError = `Status ${response.status} from ${path}`;
        }
      } catch (error) {
        lastError = `Error loading ${path}: ${error.message}`;
        continue; // Try next path
      }
    }

    if (!cssText) {
      _cssLoading = false;
      _cssLoadPromise = null;
      reject(new Error(`Failed to load CSS from all paths. Last error: ${lastError}`));
      return;
    }

    // Store CSS text for reuse
    _cssText = cssText;
    _cssLoaded = true;
    _cssLoading = false;
    _cssLoadPromise = null;
    resolve(cssText);
  });

  return _cssLoadPromise;
}

class CountriesMapCard extends HTMLElement {
  constructor() {
    super();
    // Store last rendered state to detect changes
    this._lastState = null;
    this._lastConfig = null;
    // Track if style tag has been added to this card instance
    this._styleTagAdded = false;
    
    // Pan and zoom state
    this._zoom = 2.5;
    this._minZoom = 1;
    this._maxZoom = 15;
    this._panX = 0;
    this._panY = 0;
    this._isPanning = false;
    this._startPanX = 0;
    this._startPanY = 0;
    this._startMouseX = 0;
    this._startMouseY = 0;
    
    // Original viewBox dimensions
    this._viewBoxWidth = 1000;
    this._viewBoxHeight = 666;
    
    // Touch gesture state
    this._lastTouchDistance = 0;
    this._touchStartZoom = 2.5;
    
    // Zoom indicator timeout
    this._zoomIndicatorTimeout = null;
    
    // Track if we've done initial centering (to avoid re-centering on re-renders)
    this._initialCenterDone = false;
    
    // Track card dimensions to detect size changes
    this._lastCardWidth = 0;
    this._lastCardHeight = 0;
    
    // Country info for tooltips
    this._countryInfo = {};
    
    // Bound event handlers (to allow proper removal)
    this._boundHandleMouseMove = this._handleMouseMove.bind(this);
    this._boundHandleMouseUp = this._handleMouseUp.bind(this);
    this._documentListenersAdded = false;
  }

  set hass(hass) {
    this._hass = hass;
    // Only render if relevant data has changed
    if (this._shouldUpdate()) {
      this.render();
    }
  }

  setConfig(config) {
    const configChanged = JSON.stringify(this._lastConfig) !== JSON.stringify(config);
    this._config = config;

    // Log version on first config set
    if (!_versionLogged) {
      logVersion();
      _versionLogged = true;
    }

    // If config changed, force a render
    if (configChanged) {
      this._lastConfig = JSON.parse(JSON.stringify(config));
      if (this._hass) {
        this.render();
      }
    }
  }

  getConfig() {
    return this._config;
  }

  static getConfigElement() {
    return document.createElement('countries-map-card-editor');
  }

  static getStubConfig() {
    return {
      entity: '',
      title: '',
      visited_color: '#4CAF50',
      current_color: '#FF5722',
      map_color: '#d0d0d0',
      ocean_color: ''
    };
  }

  static getGridOptions() {
    return {
      columns: 12,
      rows: 5,
      min_columns: 9,
      min_rows: 5,
      max_rows: 12
    };
  }

  _shouldUpdate() {
    if (!this._config || !this._hass) return false;

    let entity = this._config.entity || this._config.person;

    // If entity is a person entity, find the sensor entity
    if (entity && entity.startsWith('person.')) {
      const personEntity = entity;
      const allSensors = Object.keys(this._hass.states)
        .filter(id => id.startsWith('sensor.countries_visited_'))
        .map(id => {
          const state = this._hass.states[id];
          return {
            id,
            person: state?.attributes?.person,
          };
        });

      const sensorEntityId = allSensors.find(s => s.person === personEntity)?.id ||
        allSensors.find(s => s.person?.toLowerCase() === personEntity.toLowerCase())?.id;

      if (sensorEntityId) {
        entity = sensorEntityId;
      } else {
        // Can't find sensor, but might be first render - allow it
        return !this._lastState;
      }
    }

    const stateObj = this._hass.states[entity];
    if (!stateObj) return false;

    const visitedCountries = stateObj?.attributes?.visited_countries || [];
    const currentCountry = stateObj?.attributes?.current_country || null;
    const stateValue = stateObj?.state;

    // Create current state signature
    const currentState = {
      visitedCountries: JSON.stringify(visitedCountries.sort()),
      currentCountry: currentCountry,
      stateValue: stateValue,
      entity: entity
    };

    // Compare with last state
    if (!this._lastState) {
      this._lastState = currentState;
      return true; // First render
    }

    // Check if anything relevant changed
    const hasChanged =
      this._lastState.visitedCountries !== currentState.visitedCountries ||
      this._lastState.currentCountry !== currentState.currentCountry ||
      this._lastState.stateValue !== currentState.stateValue ||
      this._lastState.entity !== currentState.entity;

    if (hasChanged) {
      this._lastState = currentState;
      return true;
    }

    return false; // No relevant changes, skip render
  }

  async render() {
    if (!this._config || !this._hass) return;

    // Load CSS and inject style tag into this card (only once per card instance)
    if (!this._styleTagAdded) {
      try {
        const cssText = await loadCardCSS();
        // Create and inject style tag into this card element
        const styleTag = document.createElement('style');
        styleTag.type = 'text/css';
        styleTag.textContent = cssText;
        // Insert at the beginning of the card
        this.insertBefore(styleTag, this.firstChild);
        this._styleTagAdded = true;
      } catch (error) {
        logWarn('CSS failed to load, card may appear unstyled:', error);
        // Continue anyway - card should still work, just without styling
      }
    }

    let entity = this._config.entity || this._config.person;

    // If entity is a person entity, automatically find the corresponding sensor entity
    if (entity && entity.startsWith('person.')) {
      const personEntity = entity;

      // Find the sensor entity for this person
      // The sensor entity has the person entity ID in its attributes
      const allSensors = Object.keys(this._hass.states)
        .filter(id => id.startsWith('sensor.countries_visited_'))
        .map(id => {
          const state = this._hass.states[id];
          return {
            id,
            state: state,
            exists: !!state,
            person: state?.attributes?.person,
            hasAttributes: !!state?.attributes,
            visitedCountries: state?.attributes?.visited_countries || [],
            stateValue: state?.state,
            allAttributes: state?.attributes || {}
          };
        });

      // Try exact match first
      let sensorEntityId = allSensors.find(s => s.person === personEntity)?.id;
      let matchType = sensorEntityId ? 'exact' : null;

      // If not found, try case-insensitive match
      if (!sensorEntityId) {
        const personLower = personEntity.toLowerCase();
        const match = allSensors.find(s => s.person?.toLowerCase() === personLower);
        if (match) {
          sensorEntityId = match.id;
          matchType = 'case-insensitive';
        }
      }

      if (sensorEntityId) {
        entity = sensorEntityId;
        // Don't log successful finds - too verbose on every render
        // Only log once on first successful find
        if (!this._sensorFoundLogged) {
          this._sensorFoundLogged = true;
        }
      } else {
        // Only log error once per person entity to avoid spam
        const errorKey = `sensor_error_${personEntity}`;
        if (!_sensorErrorLogged.has(errorKey)) {
          _sensorErrorLogged.add(errorKey);

          // Detailed error logging for debugging (only once)
          const debugInfo = {
            searchingFor: personEntity,
            totalSensorsFound: allSensors.length,
            sensors: allSensors.map(s => ({
              entityId: s.id,
              exists: s.exists,
              personAttribute: s.person,
              personAttributeType: typeof s.person,
              personMatches: s.person === personEntity,
              personMatchesCaseInsensitive: s.person?.toLowerCase() === personEntity.toLowerCase(),
              hasAttributes: s.hasAttributes,
              visitedCountriesCount: s.visitedCountries?.length || 0,
              stateValue: s.stateValue
            }))
          };

          logError('Could not find sensor entity for person', {
            searchingFor: personEntity,
            totalSensorsFound: allSensors.length,
            availableSensors: allSensors.map(s => `${s.id} (person: ${s.person || 'none'})`),
            debug: debugInfo
          });
        }

        // Only throw error once per person entity to prevent console spam
        // Show a user-friendly message in the card instead of throwing repeatedly
        if (!_sensorErrorThrown.has(errorKey)) {
          _sensorErrorThrown.add(errorKey);

          // Short, user-friendly error message
          const sensorCount = allSensors.length;
          const errorMsg = sensorCount > 0
            ? `Could not find sensor for person: ${personEntity}. Found ${sensorCount} sensor(s), but none match this person. Please check the integration configuration.`
            : `Could not find sensor for person: ${personEntity}. No sensor entities found. Please install and configure the Countries Visited integration.`;

          throw new Error(errorMsg);
        }

        // If error was already thrown, show a simple message in the card instead
        // Preserve the style tag when setting innerHTML
        const existingStyleTag = this.querySelector('style');
        const styleTagContent = existingStyleTag ? existingStyleTag.outerHTML : '';

        const errorTitle = this._translate('errors.sensor_not_found', 'Sensor not found');
        const errorMessage = this._translate('errors.sensor_not_found_message', `Could not find sensor entity for person: ${personEntity}`).replace('{person}', personEntity);
        const errorHelp = this._translate('errors.sensor_not_found_help', 'Please configure the Countries Visited integration for this person.');
        const cardTitle = this._translate('title', 'Countries Visited');
        
        this.innerHTML = styleTagContent + `
          <div class="countries-card">
            <div class="card-header">
              <div class="card-title">${cardTitle}</div>
            </div>
            <div style="padding: 20px; text-align: center; color: #888;">
              <p><strong>${errorTitle}</strong></p>
              <p>${errorMessage}</p>
              <p style="font-size: 0.9em; margin-top: 10px;">${errorHelp}</p>
            </div>
          </div>
        `;
        return;
      }
    }

    const visitedColor = this._config.visited_color || '#4CAF50';
    const mapColor = this._config.map_color || '#d0d0d0';
    const currentColor = this._config.current_color || '#FF5722';
    const oceanColor = this._config.ocean_color || '';
    
    const title = this._config.title || this._translate('title', 'Countries Visited');
    const countriesText = this._translate('countries', 'countries');
    
    // Build ocean color style (transparent if not set)
    const oceanColorStyle = oceanColor ? `background: ${oceanColor};` : '';

    const stateObj = this._hass.states[entity];

    // If entity doesn't exist, throw error for Home Assistant to display
    if (!stateObj) {
      const errorMsg = this._translate('errors.entity_not_found', `Entity ${entity} not found. Make sure the Countries Visited integration is configured.`).replace('{entity}', entity);
      throw new Error(errorMsg);
    }

    const visitedCountries = stateObj?.attributes?.visited_countries || [];
    const currentCountry = stateObj?.attributes?.current_country || null;

    // Load countries data (with version tag)
    const mapDataModule = await loadMapDataModule();
    const countries = await mapDataModule.loadCountriesData();
    
    // Store country info for tooltip lookups
    this._countryInfo = countries._countryInfo || {};
    
    // Debug: Log if country info was loaded
    if (Object.keys(this._countryInfo).length > 0) {
      logDebug(`Loaded country info for ${Object.keys(this._countryInfo).length} countries`);
    } else {
      logWarn('No country info loaded - tooltips will show limited information');
    }

    // Preserve the style tag when setting innerHTML
    const existingStyleTag = this.querySelector('style');
    const styleTagContent = existingStyleTag ? existingStyleTag.outerHTML : '';
    
    this.innerHTML = styleTagContent + `
      <div class="countries-card">
        <div class="card-header">
          <div class="card-title">
            <ha-icon icon="mdi:earth" style="color: ${visitedColor};"></ha-icon>
            ${title}
            <span class="current-badge ${currentCountry ? 'visible' : ''}" style="color: ${currentColor}; background: ${currentColor}15;">
              <ha-icon icon="mdi:map-marker"></ha-icon>
              ${currentCountry || ''}
            </span>
          </div>
          <div class="card-stats" style="background: ${visitedColor}15;"><strong style="color: ${visitedColor};">${visitedCountries.length}</strong> ${countriesText}</div>
        </div>
        
        <div class="map-container" id="map-container" style="${oceanColorStyle}">
          ${this.getWorldMapSVG(countries, visitedCountries, currentCountry, mapColor, visitedColor, currentColor)}
          <div class="map-controls">
            <button class="map-control-btn zoom-in" title="${this._translate('controls.zoom_in', 'Zoom in')}">+</button>
            <button class="map-control-btn zoom-out" title="${this._translate('controls.zoom_out', 'Zoom out')}">−</button>
            <button class="map-control-btn reset zoom-reset" title="${this._translate('controls.reset_view', 'Reset view')}">
              <ha-icon icon="mdi:fit-to-screen"></ha-icon>
            </button>
          </div>
          <div class="zoom-indicator">100%</div>
          <div class="tooltip" id="tooltip"></div>
        </div>
        
        ${visitedCountries.length > 0 ? `
        <div class="country-tags">
          ${visitedCountries.map(code => `
            <span class="country-tag ${code === currentCountry ? 'current' : ''}" style="background: ${code === currentCountry ? currentColor + '20' : visitedColor + '20'}; color: ${code === currentCountry ? currentColor : visitedColor};">${code}</span>
          `).join('')}
        </div>
        ` : ''}
        
        <div class="legend">
          <div class="legend-item"><div class="legend-color visited" style="background: ${visitedColor};"></div><span>${this._translate('legend.visited', 'Visited')}</span></div>
          <div class="legend-item"><div class="legend-color current" style="background: ${currentColor};"></div><span>${this._translate('legend.current', 'Current')}</span></div>
          <div class="legend-item"><div class="legend-color default" style="background: ${mapColor};"></div><span>${this._translate('legend.not_visited', 'Not visited')}</span></div>
        </div>
      </div>
    `;

    this._setupTooltips();
    this._setupPanZoom();
    this._setupZoomControls();

    // Update last state after rendering to track what was rendered
    if (stateObj) {
      this._lastState = {
        visitedCountries: JSON.stringify(visitedCountries.sort()),
        currentCountry: currentCountry,
        stateValue: stateObj.state,
        entity: entity
      };
    }
  }

  _adjustColor(color, amount) {
    const hex = color.replace('#', '');
    const r = Math.max(0, Math.min(255, parseInt(hex.substr(0, 2), 16) + amount));
    const g = Math.max(0, Math.min(255, parseInt(hex.substr(2, 2), 16) + amount));
    const b = Math.max(0, Math.min(255, parseInt(hex.substr(4, 2), 16) + amount));
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }

  _translate(key, fallback) {
    if (!this._hass || !this._hass.localize) {
      return fallback;
    }
    
    // Try multiple translation key formats for frontend translations
    // Home Assistant loads custom integration translations with the component prefix
    const keys = [
      `component.${DOMAIN}.ui.card.countries_visited.${key}`,
      `ui.card.countries_visited.${key}`,
      `component.countries_visited.ui.card.countries_visited.${key}`,
      `config.flow.countries_visited.ui.card.countries_visited.${key}`
    ];
    
    for (const translationKey of keys) {
      try {
        const translation = this._hass.localize(translationKey);
        // Check if we got a valid translation (not the key itself)
        if (translation && translation !== translationKey) {
          return translation;
        }
      } catch (e) {
        // Continue to next key format
      }
    }
    
    return fallback;
  }

  // ==================== Pan & Zoom Methods ====================

  _getActualSvgDimensions(containerRect) {
    // Calculate actual SVG rendered size considering object-fit: contain
    const svgAspect = this._viewBoxWidth / this._viewBoxHeight;
    const containerAspect = containerRect.width / containerRect.height;
    
    let actualWidth, actualHeight, offsetX = 0, offsetY = 0;
    
    if (containerAspect > svgAspect) {
      // Container is wider - SVG height fills, width is letterboxed
      actualHeight = containerRect.height;
      actualWidth = actualHeight * svgAspect;
      offsetX = (containerRect.width - actualWidth) / 2;
    } else {
      // Container is taller - SVG width fills, height is letterboxed
      actualWidth = containerRect.width;
      actualHeight = actualWidth / svgAspect;
      offsetY = (containerRect.height - actualHeight) / 2;
    }
    
    return { width: actualWidth, height: actualHeight, offsetX, offsetY };
  }

  _setupPanZoom() {
    const container = this.querySelector('#map-container');
    const svg = container?.querySelector('svg');
    if (!container || !svg) return;

    // Remove old event handlers if elements changed
    if (this._mapContainer && this._mapContainer !== container) {
      if (this._mapContainer._wheelHandler) {
        this._mapContainer.removeEventListener('wheel', this._mapContainer._wheelHandler);
        this._mapContainer._wheelHandler = null;
      }
      if (this._mapContainer._touchstartHandler) {
        this._mapContainer.removeEventListener('touchstart', this._mapContainer._touchstartHandler);
        this._mapContainer.removeEventListener('touchmove', this._mapContainer._touchmoveHandler);
        this._mapContainer.removeEventListener('touchend', this._mapContainer._touchendHandler);
        this._mapContainer._touchstartHandler = null;
        this._mapContainer._touchmoveHandler = null;
        this._mapContainer._touchendHandler = null;
      }
    }
    
    if (this._mapSvg && this._mapSvg !== svg) {
      if (this._mapSvg._mousedownHandler) {
        this._mapSvg.removeEventListener('mousedown', this._mapSvg._mousedownHandler);
        this._mapSvg._mousedownHandler = null;
      }
    }

    // Store reference for event handlers
    this._mapContainer = container;
    this._mapSvg = svg;

    // Mouse wheel zoom (use bound handler stored on element to allow removal)
    if (!container._wheelHandler) {
      container._wheelHandler = this._handleWheel.bind(this);
      container.addEventListener('wheel', container._wheelHandler, { passive: false });
    }

    // Mouse drag pan (use bound handler stored on element)
    if (!svg._mousedownHandler) {
      svg._mousedownHandler = this._handleMouseDown.bind(this);
      svg.addEventListener('mousedown', svg._mousedownHandler);
    }
    
    // Document-level listeners (only add once per card instance)
    if (!this._documentListenersAdded) {
      document.addEventListener('mousemove', this._boundHandleMouseMove);
      document.addEventListener('mouseup', this._boundHandleMouseUp);
      this._documentListenersAdded = true;
    }

    // Touch gestures (use bound handlers stored on element)
    if (!container._touchstartHandler) {
      container._touchstartHandler = this._handleTouchStart.bind(this);
      container._touchmoveHandler = this._handleTouchMove.bind(this);
      container._touchendHandler = this._handleTouchEnd.bind(this);
      container.addEventListener('touchstart', container._touchstartHandler, { passive: false });
      container.addEventListener('touchmove', container._touchmoveHandler, { passive: false });
      container.addEventListener('touchend', container._touchendHandler);
    }

    // Double-click to zoom in
    if (!container._dblclickHandler) {
      container._dblclickHandler = this._handleDoubleClick.bind(this);
      container.addEventListener('dblclick', container._dblclickHandler);
    }

    // Center on current country if available, otherwise show full map
    const currentCountryEl = svg.querySelector('.country.current');
    
    // Check if card size changed - if so, reset initial center
    const mapContainer = this.querySelector('#map-container');
    if (mapContainer) {
      const currentWidth = mapContainer.offsetWidth;
      const currentHeight = mapContainer.offsetHeight;
      
      if (this._lastCardWidth > 0 && this._lastCardHeight > 0) {
        // Card has been sized before - check if dimensions changed significantly
        const widthChanged = Math.abs(currentWidth - this._lastCardWidth) > 10;
        const heightChanged = Math.abs(currentHeight - this._lastCardHeight) > 10;
        
        if (widthChanged || heightChanged) {
          // Size changed - reset initial center to re-center the map
          this._initialCenterDone = false;
        }
      }
      
      this._lastCardWidth = currentWidth;
      this._lastCardHeight = currentHeight;
    }
    
    if (currentCountryEl && !this._initialCenterDone) {
      this._centerOnCountry(currentCountryEl);
      this._initialCenterDone = true;
    } else if (!this._initialCenterDone) {
      // No current country - show full map at zoom 1
      this._zoom = 1;
      this._panX = 0;
      this._panY = 0;
      this._initialCenterDone = true;
    }

    // Apply initial viewBox
    this._updateViewBox();
  }

  _centerOnCountry(countryElement) {
    // Get the bounding box of the country path in SVG coordinates
    const bbox = countryElement.getBBox();
    
    // Calculate center of the country
    const countryCenterX = bbox.x + bbox.width / 2;
    const countryCenterY = bbox.y + bbox.height / 2;

    // Calculate visible area at current zoom
    const visibleWidth = this._viewBoxWidth / this._zoom;
    const visibleHeight = this._viewBoxHeight / this._zoom;

    // Calculate pan to center the country
    this._panX = countryCenterX - visibleWidth / 2;
    this._panY = countryCenterY - visibleHeight / 2;

    // Constrain to bounds
    this._constrainPan();
  }

  _handleWheel(e) {
    e.preventDefault();
    
    const container = this._mapContainer;
    const svg = this._mapSvg;
    if (!container || !svg) return;

    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Calculate zoom factor
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.max(this._minZoom, Math.min(this._maxZoom, this._zoom * zoomFactor));

    // Zoom towards mouse position
    this._zoomToPoint(mouseX, mouseY, newZoom, rect);
    this._showZoomIndicator();
  }

  _handleMouseDown(e) {
    if (e.button !== 0) return; // Only left mouse button
    
    // Ignore clicks on control buttons
    if (e.target.closest('.map-controls')) {
      return;
    }
    
    this._isPanning = true;
    this._startPanX = this._panX;
    this._startPanY = this._panY;
    this._startMouseX = e.clientX;
    this._startMouseY = e.clientY;
    
    if (this._mapSvg) {
      this._mapSvg.classList.add('grabbing');
    }
  }

  _handleMouseMove(e) {
    if (!this._isPanning) return;
    
    const container = this._mapContainer;
    const svg = this._mapSvg;
    if (!container || !svg) return;

    const rect = container.getBoundingClientRect();
    const actualSvg = this._getActualSvgDimensions(rect);
    
    const dx = (e.clientX - this._startMouseX) / actualSvg.width * this._viewBoxWidth / this._zoom;
    const dy = (e.clientY - this._startMouseY) / actualSvg.height * this._viewBoxHeight / this._zoom;

    this._panX = this._startPanX - dx;
    this._panY = this._startPanY - dy;

    this._constrainPan();
    this._updateViewBox();
  }

  _handleMouseUp() {
    this._isPanning = false;
    if (this._mapSvg) {
      this._mapSvg.classList.remove('grabbing');
    }
  }

  _handleTouchStart(e) {
    if (e.touches.length === 2) {
      // Pinch zoom start
      e.preventDefault();
      this._lastTouchDistance = this._getTouchDistance(e.touches);
      this._touchStartZoom = this._zoom;
    } else if (e.touches.length === 1) {
      // Single touch pan start
      this._isPanning = true;
      this._startPanX = this._panX;
      this._startPanY = this._panY;
      this._startMouseX = e.touches[0].clientX;
      this._startMouseY = e.touches[0].clientY;
    }
  }

  _handleTouchMove(e) {
    const container = this._mapContainer;
    if (!container) return;

    if (e.touches.length === 2) {
      // Pinch zoom
      e.preventDefault();
      const currentDistance = this._getTouchDistance(e.touches);
      const scale = currentDistance / this._lastTouchDistance;
      const newZoom = Math.max(this._minZoom, Math.min(this._maxZoom, this._touchStartZoom * scale));

      // Zoom towards center of pinch
      const rect = container.getBoundingClientRect();
      const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
      const centerY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;

      this._zoomToPoint(centerX, centerY, newZoom, rect);
      this._showZoomIndicator();
    } else if (e.touches.length === 1 && this._isPanning) {
      // Single touch pan
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const actualSvg = this._getActualSvgDimensions(rect);
      
      const dx = (e.touches[0].clientX - this._startMouseX) / actualSvg.width * this._viewBoxWidth / this._zoom;
      const dy = (e.touches[0].clientY - this._startMouseY) / actualSvg.height * this._viewBoxHeight / this._zoom;

      this._panX = this._startPanX - dx;
      this._panY = this._startPanY - dy;

      this._constrainPan();
      this._updateViewBox();
    }
  }

  _handleTouchEnd(e) {
    if (e.touches.length < 2) {
      this._lastTouchDistance = 0;
    }
    if (e.touches.length === 0) {
      this._isPanning = false;
    }
  }

  _handleDoubleClick(e) {
    // Ignore double-clicks on control buttons
    if (e.target.closest('.map-controls')) {
      return;
    }
    
    const container = this._mapContainer;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Zoom in by 2x on double-click, or reset if already at max zoom
    const newZoom = this._zoom >= this._maxZoom * 0.9 ? 1 : Math.min(this._maxZoom, this._zoom * 2);
    
    if (newZoom === 1) {
      this._resetView();
    } else {
      this._zoomToPoint(mouseX, mouseY, newZoom, rect);
    }
    this._showZoomIndicator();
  }

  _getTouchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  _zoomToPoint(pointX, pointY, newZoom, containerRect) {
    const actualSvg = this._getActualSvgDimensions(containerRect);
    
    // Adjust point coordinates to account for letterboxing
    const adjustedPointX = pointX - actualSvg.offsetX;
    const adjustedPointY = pointY - actualSvg.offsetY;
    
    // Convert screen point to viewBox coordinates before zoom
    const viewBoxX = this._panX + (adjustedPointX / actualSvg.width) * (this._viewBoxWidth / this._zoom);
    const viewBoxY = this._panY + (adjustedPointY / actualSvg.height) * (this._viewBoxHeight / this._zoom);

    // Update zoom
    this._zoom = newZoom;

    // Adjust pan to keep the point under cursor
    this._panX = viewBoxX - (adjustedPointX / actualSvg.width) * (this._viewBoxWidth / this._zoom);
    this._panY = viewBoxY - (adjustedPointY / actualSvg.height) * (this._viewBoxHeight / this._zoom);

    this._constrainPan();
    this._updateViewBox();
  }

  _constrainPan() {
    // Calculate visible area dimensions
    const visibleWidth = this._viewBoxWidth / this._zoom;
    const visibleHeight = this._viewBoxHeight / this._zoom;

    // Constrain pan to keep the map within bounds
    const maxPanX = this._viewBoxWidth - visibleWidth;
    const maxPanY = this._viewBoxHeight - visibleHeight;

    this._panX = Math.max(0, Math.min(maxPanX, this._panX));
    this._panY = Math.max(0, Math.min(maxPanY, this._panY));
  }

  _updateViewBox() {
    const svg = this._mapSvg;
    if (!svg) return;

    const visibleWidth = this._viewBoxWidth / this._zoom;
    const visibleHeight = this._viewBoxHeight / this._zoom;

    svg.setAttribute('viewBox', `${this._panX} ${this._panY} ${visibleWidth} ${visibleHeight}`);
  }

  _showZoomIndicator() {
    const indicator = this.querySelector('.zoom-indicator');
    if (!indicator) return;

    indicator.textContent = `${Math.round(this._zoom * 100)}%`;
    indicator.classList.add('visible');

    // Hide after 1.5 seconds
    clearTimeout(this._zoomIndicatorTimeout);
    this._zoomIndicatorTimeout = setTimeout(() => {
      indicator.classList.remove('visible');
    }, 1500);
  }

  _zoomIn() {
    // Zoom factor of 1.4 gives ~6 clicks from min to max zoom
    const zoomFactor = 1.4;
    
    // If already at max zoom, don't do anything
    if (this._zoom >= this._maxZoom) {
      return;
    }
    
    const newZoom = Math.min(this._maxZoom, this._zoom * zoomFactor);
    
    // Round to avoid floating point precision issues
    this._zoomAroundCenter(Math.round(newZoom * 100) / 100);
    this._showZoomIndicator();
  }

  _zoomOut() {
    // Zoom factor of 1.4 gives ~6 clicks from max to min zoom
    const zoomFactor = 1.4;
    
    // If already at min zoom, don't do anything
    if (this._zoom <= this._minZoom) {
      return;
    }
    
    const newZoom = Math.max(this._minZoom, this._zoom / zoomFactor);
    
    // Round to avoid floating point precision issues
    this._zoomAroundCenter(Math.round(newZoom * 100) / 100);
    this._showZoomIndicator();
  }

  _zoomAroundCenter(newZoom) {
    // Don't zoom if the zoom level hasn't actually changed
    if (newZoom === this._zoom) {
      return;
    }
    
    // Calculate the current center point in viewBox coordinates
    const visibleWidth = this._viewBoxWidth / this._zoom;
    const visibleHeight = this._viewBoxHeight / this._zoom;
    const centerX = this._panX + visibleWidth / 2;
    const centerY = this._panY + visibleHeight / 2;

    // Update zoom
    this._zoom = newZoom;

    // Calculate new visible area dimensions
    const newVisibleWidth = this._viewBoxWidth / this._zoom;
    const newVisibleHeight = this._viewBoxHeight / this._zoom;

    // Adjust pan to keep the same center point
    this._panX = centerX - newVisibleWidth / 2;
    this._panY = centerY - newVisibleHeight / 2;

    this._constrainPan();
    this._updateViewBox();
  }

  _resetView() {
    this._zoom = 1;
    this._panX = 0;
    this._panY = 0;
    this._updateViewBox();
    this._showZoomIndicator();
  }

  _setupZoomControls() {
    const zoomIn = this.querySelector('.zoom-in');
    const zoomOut = this.querySelector('.zoom-out');
    const reset = this.querySelector('.zoom-reset');

    // Only add handlers if not already added (check by stored handler reference)
    if (zoomIn && !zoomIn._clickHandler) {
      zoomIn._clickHandler = (e) => {
        e.stopPropagation();
        e.preventDefault();
        this._zoomIn();
      };
      zoomIn.addEventListener('click', zoomIn._clickHandler);
    }
    if (zoomOut && !zoomOut._clickHandler) {
      zoomOut._clickHandler = (e) => {
        e.stopPropagation();
        e.preventDefault();
        this._zoomOut();
      };
      zoomOut.addEventListener('click', zoomOut._clickHandler);
    }
    if (reset && !reset._clickHandler) {
      reset._clickHandler = (e) => {
        e.stopPropagation();
        e.preventDefault();
        this._resetView();
      };
      reset.addEventListener('click', reset._clickHandler);
    }
  }

  _setupTooltips() {
    const container = this.querySelector('#map-container');
    const tooltip = this.querySelector('#tooltip');
    if (!container || !tooltip) return;

    const visitedColor = this._config.visited_color || '#4CAF50';
    const currentColor = this._config.current_color || '#FF5722';

    container.querySelectorAll('.country').forEach(country => {
      const originalFill = country.getAttribute('fill');
      const isCurrent = country.classList.contains('current');
      const isVisited = country.classList.contains('visited');
      const countryCode = country.id;

      country.addEventListener('mouseenter', () => {
        // Get country info - try both uppercase and original case
        let info = {};
        if (this._countryInfo && Object.keys(this._countryInfo).length > 0) {
          info = this._countryInfo[countryCode] || this._countryInfo[countryCode.toUpperCase()] || {};
        }
        
        const name = country.getAttribute('title') || info.name || countryCode;
        
        // Build compact tooltip content
        let tooltipHTML = '';
        
        // Title with status badge (inline, more compact)
        const statusBadge = isCurrent 
          ? `<span class="tooltip-badge current" style="background: ${currentColor}20; color: ${currentColor};">${this._translate('tooltip.badge.current', 'Current')}</span>`
          : isVisited 
          ? `<span class="tooltip-badge visited" style="background: ${visitedColor}20; color: ${visitedColor};">${this._translate('tooltip.badge.visited', 'Visited')}</span>`
          : '';
        
        tooltipHTML += `<div class="tooltip-title">${name}${statusBadge ? ' ' + statusBadge : ''}</div>`;
        
        // Build compact info lines (only show if we have info)
        const infoLines = [];
        
        if (info.region) {
          const regionName = this._translate(`tooltip.regions.${info.region}`, 
            info.region === 'AF' ? 'Africa' :
            info.region === 'AS' ? 'Asia' :
            info.region === 'EU' ? 'Europe' :
            info.region === 'NA' ? 'North America' :
            info.region === 'SA' ? 'South America' :
            info.region === 'OC' ? 'Oceania' :
            info.region === 'AN' ? 'Antarctica' : info.region
          );
          const regionLabel = this._translate('tooltip.region', 'Region');
          infoLines.push(`<span class="tooltip-info-item"><span class="tooltip-label">${regionLabel}:</span> ${regionName}</span>`);
        }
        
        if (info.population !== undefined && info.population > 0) {
          const formattedPop = this._formatPopulation(info.population);
          const popLabel = this._translate('tooltip.population', 'Pop.');
          infoLines.push(`<span class="tooltip-info-item"><span class="tooltip-label">${popLabel}</span> ${formattedPop}</span>`);
        }
        
        if (info.sovereignty && info.sovereignty !== 'UN' && info.sovereignty !== 'disputed') {
          const sovereigntyLabel = this._translate('tooltip.sovereignty', 'Sovereignty');
          infoLines.push(`<span class="tooltip-info-item"><span class="tooltip-label">${sovereigntyLabel}:</span> ${info.sovereignty}</span>`);
        }
        
        // Only show additional info section if we have info
        if (infoLines.length > 0) {
          tooltipHTML += `<div class="tooltip-info">${infoLines.join('')}</div>`;
        }
        
        tooltip.innerHTML = tooltipHTML;
        tooltip.classList.add('visible');

        // Darken color on hover
        if (isCurrent) {
          country.setAttribute('fill', this._adjustColor(currentColor, -15));
        } else if (isVisited) {
          country.setAttribute('fill', this._adjustColor(visitedColor, -15));
        }
      });

      country.addEventListener('mousemove', (e) => {
        const rect = container.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();
        
        let left = e.clientX - rect.left;
        let top = e.clientY - rect.top;
        
        // Adjust horizontal position to keep tooltip within container
        const tooltipHalfWidth = tooltipRect.width / 2;
        if (left + tooltipHalfWidth > rect.width) {
          left = rect.width - tooltipHalfWidth - 10;
        } else if (left - tooltipHalfWidth < 0) {
          left = tooltipHalfWidth + 10;
        }
        
        // Adjust vertical position to keep tooltip within container
        const tooltipHeight = tooltipRect.height;
        if (top - tooltipHeight < 0) {
          top = tooltipHeight + 10;
        } else if (top > rect.height) {
          top = rect.height - 10;
        }
        
        tooltip.style.left = left + 'px';
        tooltip.style.top = top + 'px';
      });

      country.addEventListener('mouseleave', () => {
        tooltip.classList.remove('visible');
        // Restore original color
        country.setAttribute('fill', originalFill);
      });
    });
  }

  _formatPopulation(population) {
    if (population >= 1000000000) {
      return (population / 1000000000).toFixed(2) + 'B';
    } else if (population >= 1000000) {
      return (population / 1000000).toFixed(2) + 'M';
    } else if (population >= 1000) {
      return (population / 1000).toFixed(1) + 'K';
    }
    return population.toLocaleString();
  }

  getWorldMapSVG(countries, visitedCountries, currentCountry, mapColor, visitedColor, currentColor) {
    return `<svg viewBox="0 0 1000 666" preserveAspectRatio="xMidYMid meet">
      ${countries.map(c => {
      const isCurrent = currentCountry === c.id;
      const isVisited = visitedCountries.includes(c.id);
      let cls = 'country';
      let fill = mapColor;
      let stroke = 'var(--card-background-color, #fff)';
      let strokeWidth = '0.5';

      if (isCurrent) {
        cls += ' current';
        fill = currentColor;
        stroke = currentColor;
        strokeWidth = '2';
      } else if (isVisited) {
        cls += ' visited';
        fill = visitedColor;
      }

      return `<path id="${c.id}" class="${cls}" d="${c.d}" title="${c.name}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
    }).join('')}
    </svg>`;
  }
}

customElements.define('countries-map-card', CountriesMapCard);

// Visual editor for the card
class CountriesMapCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    if (this._hass) {
      this._buildEditor();
    }
  }

  connectedCallback() {
    if (this._hass) {
      this._buildEditor();
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (this.parentElement) {
      this._buildEditor();
    }
    // Update entity picker if it exists
    const entityPicker = this.querySelector('ha-entity-picker');
    if (entityPicker) {
      entityPicker.hass = hass;
    }
  }

  _buildEditor() {
    if (!this._hass) {
      return;
    }

    const config = { ...this._config };
    // Handle both entity and person aliases
    const currentEntity = config.entity || config.person || '';

    // Clear existing content and add styles
    this.innerHTML = `
      <style>
        .card-config {
          padding: 16px;
        }
        .form-group {
          margin-bottom: 16px;
        }
        .form-group ha-entity-picker,
        .form-group ha-textfield {
          display: block;
          width: 100%;
        }
      </style>
      <div class="card-config"></div>
    `;
    const container = this.querySelector('.card-config');

    // TODO: Fix entity picker - ha-entity-picker is not rendering properly
    // For now, using a text field as a workaround
    const entityGroup = document.createElement('div');
    entityGroup.className = 'form-group';
    const entityField = document.createElement('ha-textfield');
    entityField.label = 'Entity';
    entityField.value = currentEntity;
    entityField.placeholder = 'sensor.countries_visited_... or person....';
    entityField.helper = 'Enter sensor.countries_visited_* or person.* entity ID';
    entityField.addEventListener('input', (ev) => {
      this._config.entity = ev.target.value || '';
      this._fireConfigChanged();
    });
    entityGroup.appendChild(entityField);
    container.appendChild(entityGroup);

    // Title field
    const titleGroup = document.createElement('div');
    titleGroup.className = 'form-group';
    const titleField = document.createElement('ha-textfield');
    titleField.label = 'Title (optional)';
    titleField.value = config.title || '';
    titleField.placeholder = 'Countries Visited';
    titleField.addEventListener('input', (ev) => {
      this._config.title = ev.target.value || '';
      this._fireConfigChanged();
    });
    titleGroup.appendChild(titleField);
    container.appendChild(titleGroup);

    // Visited color
    const visitedColorGroup = document.createElement('div');
    visitedColorGroup.className = 'form-group';
    const visitedColorLabel = document.createElement('label');
    visitedColorLabel.textContent = 'Visited Color';
    visitedColorLabel.style.display = 'block';
    visitedColorLabel.style.marginBottom = '8px';
    visitedColorGroup.appendChild(visitedColorLabel);
    const visitedColorInput = document.createElement('input');
    visitedColorInput.type = 'color';
    visitedColorInput.value = config.visited_color || '#4CAF50';
    visitedColorInput.style.width = '100%';
    visitedColorInput.style.height = '40px';
    visitedColorInput.style.border = '1px solid var(--divider-color, #e0e0e0)';
    visitedColorInput.style.borderRadius = '4px';
    visitedColorInput.style.cursor = 'pointer';
    visitedColorInput.addEventListener('input', (ev) => {
      this._config.visited_color = ev.target.value || '#4CAF50';
      this._fireConfigChanged();
    });
    visitedColorGroup.appendChild(visitedColorInput);
    container.appendChild(visitedColorGroup);

    // Current color
    const currentColorGroup = document.createElement('div');
    currentColorGroup.className = 'form-group';
    const currentColorLabel = document.createElement('label');
    currentColorLabel.textContent = 'Current Color';
    currentColorLabel.style.display = 'block';
    currentColorLabel.style.marginBottom = '8px';
    currentColorGroup.appendChild(currentColorLabel);
    const currentColorInput = document.createElement('input');
    currentColorInput.type = 'color';
    currentColorInput.value = config.current_color || '#FF5722';
    currentColorInput.style.width = '100%';
    currentColorInput.style.height = '40px';
    currentColorInput.style.border = '1px solid var(--divider-color, #e0e0e0)';
    currentColorInput.style.borderRadius = '4px';
    currentColorInput.style.cursor = 'pointer';
    currentColorInput.addEventListener('input', (ev) => {
      this._config.current_color = ev.target.value || '#FF5722';
      this._fireConfigChanged();
    });
    currentColorGroup.appendChild(currentColorInput);
    container.appendChild(currentColorGroup);

    // Map color
    const mapColorGroup = document.createElement('div');
    mapColorGroup.className = 'form-group';
    const mapColorLabel = document.createElement('label');
    mapColorLabel.textContent = 'Country Color (default)';
    mapColorLabel.style.display = 'block';
    mapColorLabel.style.marginBottom = '8px';
    mapColorGroup.appendChild(mapColorLabel);
    const mapColorInput = document.createElement('input');
    mapColorInput.type = 'color';
    mapColorInput.value = config.map_color || '#d0d0d0';
    mapColorInput.style.width = '100%';
    mapColorInput.style.height = '40px';
    mapColorInput.style.border = '1px solid var(--divider-color, #e0e0e0)';
    mapColorInput.style.borderRadius = '4px';
    mapColorInput.style.cursor = 'pointer';
    mapColorInput.addEventListener('input', (ev) => {
      this._config.map_color = ev.target.value || '#d0d0d0';
      this._fireConfigChanged();
    });
    mapColorGroup.appendChild(mapColorInput);
    container.appendChild(mapColorGroup);

    // Ocean color
    const oceanColorGroup = document.createElement('div');
    oceanColorGroup.className = 'form-group';
    const oceanColorLabel = document.createElement('label');
    oceanColorLabel.textContent = 'Ocean Color';
    oceanColorLabel.style.display = 'block';
    oceanColorLabel.style.marginBottom = '8px';
    oceanColorGroup.appendChild(oceanColorLabel);

    // Checkbox for transparent
    const transparentCheckbox = document.createElement('ha-switch');
    transparentCheckbox.checked = !config.ocean_color || config.ocean_color === '';
    transparentCheckbox.style.marginBottom = '8px';
    const transparentLabel = document.createElement('label');
    transparentLabel.textContent = 'Transparent (default)';
    transparentLabel.style.marginLeft = '8px';
    transparentLabel.style.cursor = 'pointer';
    transparentLabel.style.display = 'inline-block';
    transparentLabel.addEventListener('click', () => {
      transparentCheckbox.checked = !transparentCheckbox.checked;
      transparentCheckbox.dispatchEvent(new Event('change'));
    });
    
    const transparentContainer = document.createElement('div');
    transparentContainer.style.display = 'flex';
    transparentContainer.style.alignItems = 'center';
    transparentContainer.appendChild(transparentCheckbox);
    transparentContainer.appendChild(transparentLabel);
    oceanColorGroup.appendChild(transparentContainer);

    // Color input (disabled when transparent is checked)
    const oceanColorInput = document.createElement('input');
    oceanColorInput.type = 'color';
    oceanColorInput.value = config.ocean_color || '#ffffff';
    oceanColorInput.disabled = !config.ocean_color || config.ocean_color === '';
    oceanColorInput.style.width = '100%';
    oceanColorInput.style.height = '40px';
    oceanColorInput.style.border = '1px solid var(--divider-color, #e0e0e0)';
    oceanColorInput.style.borderRadius = '4px';
    oceanColorInput.style.cursor = oceanColorInput.disabled ? 'not-allowed' : 'pointer';
    oceanColorInput.style.opacity = oceanColorInput.disabled ? '0.5' : '1';
    oceanColorInput.style.marginTop = '8px';
    
    transparentCheckbox.addEventListener('change', (ev) => {
      if (ev.target.checked) {
        // Transparent selected
        this._config.ocean_color = '';
        oceanColorInput.disabled = true;
        oceanColorInput.style.cursor = 'not-allowed';
        oceanColorInput.style.opacity = '0.5';
      } else {
        // Color selected
        oceanColorInput.disabled = false;
        oceanColorInput.style.cursor = 'pointer';
        oceanColorInput.style.opacity = '1';
        if (!this._config.ocean_color) {
          this._config.ocean_color = oceanColorInput.value;
        }
      }
      this._fireConfigChanged();
    });
    
    oceanColorInput.addEventListener('input', (ev) => {
      if (!oceanColorInput.disabled) {
        this._config.ocean_color = ev.target.value;
        this._fireConfigChanged();
      }
    });
    oceanColorGroup.appendChild(oceanColorInput);
    container.appendChild(oceanColorGroup);
  }

  _fireConfigChanged() {
    const event = new CustomEvent('config-changed', {
      detail: { config: this._getConfig() },
      bubbles: true,
      composed: true
    });
    this.dispatchEvent(event);
  }

  _getConfig() {
    const config = {};
    if (this._config.entity) config.entity = this._config.entity;
    if (this._config.title) config.title = this._config.title;
    if (this._config.visited_color && this._config.visited_color !== '#4CAF50') {
      config.visited_color = this._config.visited_color;
    }
    if (this._config.current_color && this._config.current_color !== '#FF5722') {
      config.current_color = this._config.current_color;
    }
    if (this._config.map_color && this._config.map_color !== '#d0d0d0') {
      config.map_color = this._config.map_color;
    }
    if (this._config.ocean_color) {
      config.ocean_color = this._config.ocean_color;
    }
    return config;
  }
}

// Register the editor
customElements.define('countries-map-card-editor', CountriesMapCardEditor);

// Register card with Home Assistant's card registry
if (window.customCards) {
  window.customCards.push({
    type: 'countries-map-card',
    name: 'Countries Visited',
    description: 'Interactive world map showing visited countries',
    preview: false,
    icon: '/hacsfiles/countries-visited/icon.svg',
    documentationURL: 'https://github.com/RorGray/countries-visited'
  });
}

// Also register with HA's internal registry if available
if (window.loadCardHelpers) {
  window.loadCardHelpers().then((helpers) => {
    // Card helpers are loaded, card should be discoverable
    if (!_versionLogged) {
      logVersion();
      _versionLogged = true;
    }
  });
}
