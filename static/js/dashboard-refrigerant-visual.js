// Refrigerant Circuit Visualization
// Visual representation of the heat pump refrigerant cycle with real-time data overlay

// Helper function to get water density based on temperature
function getWaterDensity(tempC) {
    // Approximate water density as function of temperature (kg/m³)
    // Linear approximation: ρ(T) ≈ 1000 - 0.3 × T
    return 1000 - 0.3 * tempC;
}

// validate value
function validate(featureVal) {
    if (featureVal && featureVal.value !== null && featureVal.value !== undefined){
		if (typeof featureVal.value === 'number'){
			return featureVal.value;
		}
    }
    return null;
}

function isVitocal200G(deviceInfo, keyFeatures) {
    const modelNames = [
        deviceInfo?.modelId,
        deviceInfo?.displayName,
        keyFeatures?.deviceVariant?.value
    ].filter(value => typeof value === 'string').join(' ');

    return /vitocal[\s_-]*200[\s_-]*g/i.test(modelNames);
}

function numericFeatureValue(feature) {
    let value = feature?.value;
    while (value && typeof value === 'object' && value.value !== undefined) {
        value = value.value;
    }
    return typeof value === 'number' ? value : null;
}

function formatHydraulicValue(feature, unit) {
    const value = numericFeatureValue(feature);
    return value === null ? '—' : `${value.toFixed(1)} ${unit}`;
}

function snapshotCompressorState(snapshot) {
    const state = snapshot?.compressor_active;
    if (typeof state === 'boolean') return state;
    if (typeof state === 'number') return state > 0;
    if (typeof state === 'string') {
        const normalized = state.trim().toLowerCase();
        if (['on', 'active', 'running', 'true', 'enabled'].includes(normalized)) return true;
        if (['off', 'inactive', 'stopped', 'false', 'disabled'].includes(normalized)) return false;
    }
    return typeof snapshot?.compressor_speed === 'number' ? snapshot.compressor_speed > 0 : null;
}

function compressorLoadType(snapshot) {
    if (snapshot?.dhw_pump_active === true) return 'Warmwasserladung';
    if (snapshot?.dhw_pump_active === false) return 'Heizungsladung';
    return 'Betriebsart nicht erfasst';
}

function formatCompressorDuration(durationMs, running = false) {
    if (!Number.isFinite(durationMs) || durationMs < 0) return 'Dauer nicht erfasst';
    const minutes = Math.round(durationMs / 60000);
    const duration = minutes < 60
        ? `${minutes} min`
        : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
    return running ? `läuft seit ${duration}` : duration;
}

function buildDailyCompressorStarts(snapshots, now = new Date(), sampleIntervalMinutes = 1) {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const days = Array.from({ length: 7 }, (_, index) => {
        const date = new Date(today);
        date.setDate(today.getDate() - (6 - index));
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        return {
            date,
            key,
            count: 0,
            hasData: false,
            events: [],
            counterHints: [],
            energy: {
                dhw: { electricityKwh: 0, thermalKwh: 0, hasElectricity: false, hasThermal: false },
                heating: { electricityKwh: 0, thermalKwh: 0, hasElectricity: false, hasThermal: false },
                unknown: { electricityKwh: 0, thermalKwh: 0, hasElectricity: false, hasThermal: false }
            }
        };
    });
    const dayByKey = new Map(days.map(day => [day.key, day]));
    const ordered = (Array.isArray(snapshots) ? snapshots : [])
        .filter(snapshot => snapshot?.timestamp && Number.isFinite(new Date(snapshot.timestamp).getTime()))
        .sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp));

    const dayForTimestamp = timestamp => {
        const date = new Date(timestamp);
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        return dayByKey.get(key) || null;
    };
    let previousCounter = null;
    let previousSnapshot = null;
    let previousActive = null;
    let activeEvent = null;

    for (const snapshot of ordered) {
        const timestamp = new Date(snapshot.timestamp);
        const day = dayForTimestamp(timestamp);

        if (typeof snapshot.compressor_starts === 'number' && Number.isFinite(snapshot.compressor_starts)) {
            const starts = snapshot.compressor_starts;
            if (previousCounter) {
                const delta = starts >= previousCounter.starts ? starts - previousCounter.starts : starts;
                if (delta > 0 && day) {
                    day.count += Math.round(delta);
                    day.hasData = true;
                    for (let index = 0; index < Math.round(delta); index++) {
                        day.counterHints.push({ timestamp, loadType: compressorLoadType(snapshot) });
                    }
                }
            }
            previousCounter = { starts, timestamp };
        }

        const active = snapshotCompressorState(snapshot);
        if (active !== null && day) {
            if (active && previousActive === false) {
                activeEvent = {
                    timestamp,
                    durationMs: null,
                    loadType: compressorLoadType(snapshot),
                    running: false
                };
                day.events.push(activeEvent);
                day.hasData = true;
            } else if (!active && previousActive === true && activeEvent) {
                activeEvent.durationMs = timestamp - activeEvent.timestamp;
                activeEvent = null;
            }
        }

        if (previousSnapshot) {
            const previousTime = new Date(previousSnapshot.timestamp);
            const elapsedMs = timestamp - previousTime;
            const maxGapMs = Math.max(1, Number(sampleIntervalMinutes) || 1) * 2 * 60000;
            const previouslyActive = snapshotCompressorState(previousSnapshot);
            if (elapsedMs > 0 && elapsedMs <= maxGapMs && (active === true || previouslyActive === true) && day) {
                const activeSnapshot = active === true ? snapshot : previousSnapshot;
                const loadType = compressorLoadType(activeSnapshot);
                const energy = loadType === 'Warmwasserladung' ? day.energy.dhw
                    : loadType === 'Heizungsladung' ? day.energy.heating
                    : day.energy.unknown;
                const hours = elapsedMs / 3600000;
                const electricalSamples = [previousSnapshot.compressor_power, snapshot.compressor_power]
                    .filter(value => typeof value === 'number' && Number.isFinite(value));
                if (electricalSamples.length) {
                    const averageWatts = electricalSamples.reduce((sum, value) => sum + value, 0) / electricalSamples.length;
                    energy.electricityKwh += averageWatts * hours / 1000;
                    energy.hasElectricity = true;
                    day.hasData = true;
                }
                const thermalSamples = [previousSnapshot.thermal_power, snapshot.thermal_power]
                    .filter(value => typeof value === 'number' && Number.isFinite(value));
                if (thermalSamples.length) {
                    const averageKilowatts = thermalSamples.reduce((sum, value) => sum + value, 0) / thermalSamples.length;
                    energy.thermalKwh += averageKilowatts * hours;
                    energy.hasThermal = true;
                    day.hasData = true;
                }
            }
        }

        if (active !== null) previousActive = active;
        previousSnapshot = snapshot;
    }

    if (activeEvent && ordered.length) {
        activeEvent.durationMs = new Date(ordered[ordered.length - 1].timestamp) - activeEvent.timestamp;
        activeEvent.running = true;
    }

    for (const day of days) {
        const statusEvents = [...day.events];
        const unmatchedHints = [...day.counterHints];
        for (const event of statusEvents) {
            let matchIndex = -1;
            let bestDistance = Infinity;
            unmatchedHints.forEach((hint, index) => {
                const distance = Math.abs(hint.timestamp - event.timestamp);
                if (distance < bestDistance && distance <= Math.max(1, Number(sampleIntervalMinutes) || 1) * 3 * 60000) {
                    bestDistance = distance;
                    matchIndex = index;
                }
            });
            if (matchIndex >= 0) unmatchedHints.splice(matchIndex, 1);
        }
        for (const hint of unmatchedHints) {
            day.events.push({
                timestamp: hint.timestamp,
                durationMs: null,
                loadType: hint.loadType,
                running: false,
                detailMissing: true
            });
        }
        day.count = Math.max(day.count, day.events.length);
        const measuredDurations = day.events
            .filter(event => !event.detailMissing && Number.isFinite(event.durationMs))
            .map(event => event.durationMs);
        day.averageRuntimeMs = measuredDurations.length
            ? measuredDurations.reduce((sum, duration) => sum + duration, 0) / measuredDurations.length
            : null;
    }

    return days.map(day => ({
        ...day,
        weekday: day.date.toLocaleDateString('de-DE', { weekday: 'short' }),
        dateLabel: day.date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
    }));
}

const compressorStartsMiniCache = new Map();

async function loadCompressorStartsMiniChart(deviceInfo) {
    const container = document.getElementById('compressor-starts-mini-chart');
    if (!container || !deviceInfo?.installationId) return;

    const cacheKey = `${deviceInfo.installationId}_${deviceInfo.gatewaySerial || ''}_${deviceInfo.deviceId || ''}`;
    const cached = compressorStartsMiniCache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < 60 * 1000) {
        renderCompressorStartsMiniChart(container, cached.days);
        return;
    }

    try {
        const params = new URLSearchParams({
            installationId: deviceInfo.installationId,
            hours: '192',
            limit: '15000'
        });
        if (deviceInfo.gatewaySerial) params.set('gatewayId', deviceInfo.gatewaySerial);
        if (deviceInfo.deviceId) params.set('deviceId', deviceInfo.deviceId);

        const [response, settingsResponse] = await Promise.all([
            fetch(`/api/temperature-log/data?${params.toString()}`),
            fetch('/api/temperature-log/settings')
        ]);
        if (!response.ok) throw new Error(`API ${response.status}`);
        const result = await response.json();
        const settings = settingsResponse.ok ? await settingsResponse.json() : {};
        const sampleInterval = Number(settings.sample_interval) > 0 ? Number(settings.sample_interval) : 1;
        const days = buildDailyCompressorStarts(result.data, new Date(), sampleInterval);
        compressorStartsMiniCache.set(cacheKey, { days, loadedAt: Date.now() });
        renderCompressorStartsMiniChart(container, days);
    } catch (error) {
        console.warn('Compressor start history unavailable:', error);
        container.innerHTML = '<div class="compressor-starts-empty">Startverlauf nicht verfügbar</div>';
    }
}

function renderCompressorStartsMiniChart(container, days) {
    if (!days.some(day => day.hasData)) {
        container.innerHTML = '<div class="compressor-starts-empty">Noch keine Startverläufe gespeichert</div>';
        return;
    }

    const maxCount = Math.max(1, ...days.filter(day => day.hasData).map(day => day.count));
    const energyText = energy => {
        const electricity = energy.hasElectricity ? energy.electricityKwh.toFixed(2) : '—';
        const thermal = energy.hasThermal ? energy.thermalKwh.toFixed(2) : '—';
        return `${electricity}/${thermal}`;
    };
    const bars = days.map(day => {
        const width = day.hasData && day.count > 0 ? Math.max(2, day.count / maxCount * 100) : 0;
        const value = day.hasData ? day.count : '—';
        const startLines = day.events.length
            ? day.events.map(event => {
                const time = new Date(event.timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
                const duration = event.detailMissing
                    ? 'Dauer nicht in Status-Snapshots erfasst'
                    : formatCompressorDuration(event.durationMs, event.running);
                return `${time} · ${duration} · ${event.loadType}`;
            })
            : ['Einzelstartdetails nicht in Status-Snapshots erfasst'];
        const title = [
            `${day.weekday} ${day.dateLabel} · ${day.hasData ? `${day.count} Verdichterstarts` : 'keine Daten'}`,
            'Starts:',
            ...startLines,
            'Energie (Strom/Wärme in kWh):',
            `Warmwasser: ${energyText(day.energy.dhw)}`,
            `Heizung: ${energyText(day.energy.heating)}`,
            ...(day.energy.unknown.hasElectricity || day.energy.unknown.hasThermal
                ? [`Nicht zugeordnet: ${energyText(day.energy.unknown)}`]
                : [])
        ].join('\n');
        const averageRuntime = day.averageRuntimeMs === null
            ? '—'
            : formatCompressorDuration(day.averageRuntimeMs);
        const totalEnergy = Object.values(day.energy).reduce((total, energy) => {
            total.electricityKwh += energy.electricityKwh;
            total.thermalKwh += energy.thermalKwh;
            total.hasElectricity ||= energy.hasElectricity;
            total.hasThermal ||= energy.hasThermal;
            return total;
        }, { electricityKwh: 0, thermalKwh: 0, hasElectricity: false, hasThermal: false });
        return `<div class="compressor-start-day" title="${title}">
            <span class="compressor-start-date">${day.weekday}</span>
            <div class="compressor-start-track"><div class="compressor-start-bar" style="width:${width}%"></div></div>
            <span class="compressor-start-count">${value}</span>
            <span class="compressor-start-energy compressor-start-total" title="Summe der erfassten Stromverbräuche / Wärmemengen in kWh">Σ ${energyText(totalEnergy)}</span>
            <span class="compressor-start-energy compressor-start-dhw" title="Warmwasser: Stromverbrauch / Wärmemenge in kWh">WW ${energyText(day.energy.dhw)}</span>
            <span class="compressor-start-energy compressor-start-heating" title="Heizung: Stromverbrauch / Wärmemenge in kWh">H ${energyText(day.energy.heating)}</span>
            <span class="compressor-start-runtime" title="Mittlere Verdichterlaufzeit je Start">Ø ${averageRuntime}</span>
        </div>`;
    }).join('');

    return container.innerHTML = `<div class="compressor-starts-bars">${bars}</div>`;
}

function getHeatingPumpState(statusFeature, speedFeature) {
    let status = statusFeature?.value;
    while (status && typeof status === 'object' && status.value !== undefined) {
        status = status.value;
    }

    if (typeof status === 'boolean') return status;
    if (typeof status === 'number') return status > 0;
    if (typeof status === 'string') {
        const normalized = status.trim().toLowerCase();
        if (['on', 'active', 'running', 'true', 'enabled'].includes(normalized)) return true;
        if (['off', 'inactive', 'stopped', 'false', 'disabled'].includes(normalized)) return false;
    }

    const speed = numericFeatureValue(speedFeature);
    return speed === null ? null : speed > 0;
}

function renderVitocellHydraulics(keyFeatures, compressorActive, activeFeed) {
    const circuits = keyFeatures.heatingCircuits || [];
    const badges = [
        { feature: compressorActive ? keyFeatures.primarySupplyTemp : null, title: 'Sole-Eintritt zur Vitocal', left: 19, top: 38 },
        { feature: compressorActive ? keyFeatures.primaryReturnTemp : null, title: 'Sole-Austritt zur Erdsonde', left: 19, top: 47 },
        { feature: keyFeatures.dhwTemp, title: 'Temperatur Warmwasserzone', left: 50.4, top: 15 },
        { feature: keyFeatures.bufferTempTop, title: 'Temperatur Puffer oben · Heizzone', left: 50.4, top: 70 },
        { feature: circuits[0]?.returnTemp, title: 'Pufferheizkreis-Rücklauf', left: 39, top: 79 },
        { feature: circuits[1]?.supplyTemp, title: 'Heizkörper-Vorlauf', left: 67, top: 26 },
        { feature: circuits[1]?.returnTemp, title: 'Heizkörper-Rücklauf', left: 96, top: 46, alignRight: true },
        { feature: circuits[2]?.supplyTemp, title: 'Fußbodenheizungs-Vorlauf', left: 67, top: 68 },
        { feature: circuits[2]?.returnTemp, title: 'Fußbodenheizungs-Rücklauf', left: 96, top: 72, alignRight: true }
    ];
    const temperatureBadges = badges.map(({ feature, title, left, top, alignRight }) => {
        const value = numericFeatureValue(feature);
        if (value === null) return '';
        const alignment = alignRight ? ' vitocell-temp-badge-right' : '';
        return `<span class="vitocell-temp-badge${alignment}" title="${title}" style="left:${left}%;top:${top}%">${value.toFixed(1)} °C</span>`;
    }).join('');
    const hk1SupplyValue = numericFeatureValue(circuits[0]?.supplyTemp);
    const hk1SupplyBadge = activeFeed && hk1SupplyValue !== null
        ? `<span class="vitocell-temp-badge" title="Pufferheizkreis-Vorlauf · ${activeFeed === 'dhw' ? 'Warmwasserzone' : 'Heizzone'}" style="left:41.5%;top:${activeFeed === 'dhw' ? 16 : 63}%">${hk1SupplyValue.toFixed(1)} °C</span>`
        : '';
    const mixerPosition = numericFeatureValue(circuits[2]?.mixerPosition);
    const mixerBadge = mixerPosition === null || !Number.isFinite(mixerPosition)
        ? ''
        : `<span class="vitocell-state-badge" title="Mischerstellung Fußbodenheizung" style="left:81.1%;top:78%">Mischer ${Math.round(mixerPosition)} %</span>`;
    const pumpPositions = [
        { left: 72, top: 30.8, title: 'Heizkörper' },
        { left: 72, top: 73.2, title: 'Fußbodenheizung' }
    ];
    const pumpIndicators = circuits.slice(1, 3).map((circuit, index) => {
        const state = getHeatingPumpState(circuit.pumpStatus, circuit.pumpSpeed);
        const position = pumpPositions[index];
        const style = `left:${position.left}%;top:${position.top}%`;
        if (state !== true) return '';
        return `<img class="vitocell-pump-motor" src="/static/img/vitocal/Fan_active.gif" alt="${position.title}: Pumpe aktiv" title="${position.title}: Heizkreispumpe aktiv" style="${style}">`;
    }).join('');
    const mobileTemperature = (feature, label, unit = '°C') => {
        const value = numericFeatureValue(feature);
        return `<span class="vitocell-mobile-temp" title="${label}"><span>${label}</span><strong>${value === null ? '—' : `${value.toFixed(1)} ${unit}`}</strong></span>`;
    };
    const mobilePumpStatus = circuit => {
        const state = getHeatingPumpState(circuit.pumpStatus, circuit.pumpSpeed);
        const label = state === true ? 'Pumpe aktiv' : state === false ? 'Pumpe aus' : 'Pumpenstatus —';
        const icon = state === true ? '<img src="/static/img/vitocal/Fan_active.gif" alt="">' : '';
        return `<span class="vitocell-mobile-pump${state === true ? ' active' : ''}">${icon}${label}</span>`;
    };
    const activeFeedLabel = activeFeed === 'dhw' ? 'Warmwasserladung' : activeFeed === 'heating' ? 'Heizbetrieb' : '';
    const activeMotor = compressorActive && activeFeed
        ? `<img class="vitocell-active-motor" src="/static/img/vitocal/Fan_active.gif" alt="Verdichter aktiv" title="Verdichter aktiv · ${activeFeedLabel}" style="left:44%;top:${activeFeed === 'dhw' ? 22 : 68}%">`
        : '';
    const mobileActiveMotor = compressorActive && activeFeed
        ? `<span class="vitocell-mobile-pump active"><img src="/static/img/vitocal/Fan_active.gif" alt="">Verdichter aktiv · ${activeFeedLabel}</span>`
        : '';

    return `
        <section class="vitocell-hydraulic-panel" aria-label="Vitocell 120-E und Heizkreise">
            <div class="vitocell-panel-heading">
                <section id="compressor-starts-mini-chart" class="compressor-starts-mini-chart" aria-label="Verdichterstarts der letzten sieben Tage">
                    <div class="compressor-starts-empty">Verdichterstarts werden geladen…</div>
                </section>
            </div>
            <div class="vitocell-hydraulic-scroll">
                <div class="vitocell-hydraulic-diagram">
                    <img src="/static/img/vitocal/Vitocell120eHydraulik.svg"
                        alt="Schematischer Solekreis und Vitocell 120-E mit Warmwasserzone, Heizzone, Heizkörper- und Fußbodenheizkreis">
                    ${activeMotor}
                    ${hk1SupplyBadge}
                    ${mixerBadge}
                    ${pumpIndicators}
                    ${temperatureBadges}
                </div>
                <div class="vitocell-mobile-diagram">
                    <div class="vitocell-mobile-sole-loop">
                        <div class="vitocell-mobile-node">
                            <strong>Erdsonde</strong>
                            ${mobileTemperature(keyFeatures.primarySupplyTemp, 'Sole-Eintritt zur Vitocal')}
                            ${mobileTemperature(keyFeatures.primaryReturnTemp, 'Sole-Austritt zur Erdsonde')}
                        </div>
                        <div class="vitocell-mobile-flow" aria-hidden="true"><i class="hot"></i><i class="cool"></i></div>
                        <div class="vitocell-mobile-node vitocell-mobile-heat-pump">
                            <strong>Vitocal 200-G</strong>
                            ${mobileActiveMotor}
                        </div>
                    </div>
                    <div class="vitocell-mobile-flow-pair" aria-hidden="true"><i class="hot"></i><i class="cool"></i></div>
                    <div class="vitocell-mobile-connection">HK1 · Vorlauf zum Puffer / Rücklauf zur Vitocal</div>
                    <div class="vitocell-mobile-tank">
                        <section class="vitocell-mobile-zone warm">
                            <strong>Warmwasserzone</strong>
                            <div class="vitocell-mobile-values">
                                ${mobileTemperature(keyFeatures.dhwTemp, 'Speichertemperatur')}
                                ${mobileTemperature(circuits[0]?.supplyTemp, 'HK1 Vorlauf')}
                            </div>
                        </section>
                        <section class="vitocell-mobile-zone heating">
                            <strong>Heizzone</strong>
                            <div class="vitocell-mobile-values">
                                ${mobileTemperature(keyFeatures.bufferTempTop, 'Puffer oben')}
                                ${mobileTemperature(circuits[0]?.returnTemp, 'HK1 Rücklauf')}
                            </div>
                        </section>
                    </div>
                    <div class="vitocell-mobile-connection">HK2 / HK3 · Vorlauf und gemeinsamer Rücklauf</div>
                    <div class="vitocell-mobile-circuit-flows" aria-hidden="true">
                        <div class="vitocell-mobile-flow-pair"><i class="hot"></i><i class="cool"></i></div>
                        <div class="vitocell-mobile-flow-pair"><i class="hot"></i><i class="cool"></i></div>
                    </div>
                    <div class="vitocell-mobile-circuits">
                        <section class="vitocell-mobile-circuit">
                            <div class="vitocell-mobile-circuit-heading"><strong>HK2 · Heizkörper</strong>${mobilePumpStatus(circuits[1] || {})}</div>
                            <div class="vitocell-mobile-values">
                                ${mobileTemperature(circuits[1]?.supplyTemp, 'Vorlauf')}
                                ${mobileTemperature(circuits[1]?.returnTemp, 'Rücklauf')}
                            </div>
                        </section>
                        <section class="vitocell-mobile-circuit">
                            <div class="vitocell-mobile-circuit-heading"><strong>HK3 · Fußbodenheizung</strong>${mobilePumpStatus(circuits[2] || {})}</div>
                            <div class="vitocell-mobile-values">
                                ${mobileTemperature(circuits[2]?.supplyTemp, 'Vorlauf')}
                                ${mobileTemperature(circuits[2]?.returnTemp, 'Rücklauf')}
                                ${mobileTemperature(circuits[2]?.mixerPosition, 'Mischerstellung', '%')}
                            </div>
                        </section>
                    </div>
                </div>
            </div>
        </section>
    `;
}

function renderRefrigerantCircuitVisual(keyFeatures) {

	// Get device settings to determine: hasHotWaterBuffer, refrigerant-picture, compressor rpm
    const deviceInfo = window.currentDeviceInfo;
    const deviceKey = deviceInfo ? (deviceInfo.installationId + '_' + deviceInfo.deviceId) : null;
    const deviceSetting = deviceKey && window.deviceSettingsCache ? window.deviceSettingsCache[deviceKey] : null;
    let hasHotWaterBuffer = true; // default
    if (deviceSetting && deviceSetting.hasHotWaterBuffer !== null && deviceSetting.hasHotWaterBuffer !== undefined) {
        hasHotWaterBuffer = deviceSetting.hasHotWaterBuffer;
    }
	const useOtherPic = typeof deviceSetting?.useOtherRefrigerantPic === 'boolean'
        ? deviceSetting.useOtherRefrigerantPic
        : isVitocal200G(deviceInfo, keyFeatures);

    // Check if we have compressor data (heat pump only)
    const hasCompressor = keyFeatures.compressorActive !== null ||
                         keyFeatures.compressorSpeed !== null ||
                         keyFeatures.compressorInletTemp !== null;

    if (!hasCompressor) {
        return ''; // Not a heat pump, don't show visualization
    }

    const compressorActive = keyFeatures.compressorActive?.value === true ||
        (typeof keyFeatures.compressorSpeed?.value === 'number' && keyFeatures.compressorSpeed.value > 0);
    const dhwActive = ['on', 'active', 'dhw'].includes(keyFeatures.dhwStatus?.value) ||
        keyFeatures.operatingMode?.value === 'dhw';
    const heatingCircuitActive = ['heating', 'dhwAndHeating'].includes(keyFeatures.operatingMode?.value) ||
        (keyFeatures.heatingCircuits || []).some(circuit => {
            const supply = numericFeatureValue(circuit.supplyTemp);
            const returnValue = numericFeatureValue(circuit.returnTemp);
            return supply !== null && (returnValue === null || supply > returnValue);
        });
    const activeFeed = !compressorActive ? null : dhwActive ? 'dhw' : heatingCircuitActive ? 'heating' : null;
	
    // Use the brine/water diagram automatically for Vitocal 200-G unless a device override exists.
    if (useOtherPic){
		return renderOtherRefrigerantCircuitPic(keyFeatures, compressorActive, activeFeed)
	}	
	
    // Select base image (active or inactive)
    let baseImage = compressorActive ?
        '/static/img/vitocal/Kaeltekreislauf%20ein.jpg' : '/static/img/vitocal/Kaeltekreislauf%20aus.jpg';
	if (compressorActive && keyFeatures?.fourWayValve && 
		(keyFeatures.fourWayValve.value === 'climatCircuitTwoDefrost' || keyFeatures.fourWayValve.value === 'defrost')) {
        baseImage = '/static/img/vitocal/Kaeltekreislauf%20abtau.jpg';
    }

    // Check if DHW is active (heating domestic hot water)
	let dhw_exists = false;
	let dhw_image =  ""; // no dhw 
    // Check if DHW exists or on intended temperature or is active (heating domestic hot water)
	if (keyFeatures.dhwStatus?.value === 'off' || keyFeatures.dhwStatus?.value === 'inactive'){
		dhw_exists = true;
		dhw_image = "/static/img/vitocal/Warmwasserspeicher%20aus.png"; // dhw is off 
	} else{
	  if (keyFeatures.dhwTemp?.value && keyFeatures.dhwTarget?.value){
		dhw_exists = true;
		dhw_image = "/static/img/vitocal/Warmwasserspeicher%20temp.png"; // dhw has intended temp
		if ( keyFeatures?.dhwHysteresisSwitchOn?.value ){
			if (keyFeatures.dhwTemp.value <= (keyFeatures.dhwTarget.value - keyFeatures.dhwHysteresisSwitchOn.value)){
				dhw_image = "/static/img/vitocal/Warmwasserspeicher_cold.png"; // dhw has low temp
			}
		}
	  } 
	}
    if (keyFeatures.dhwStatus?.value === 'on' || keyFeatures.dhwStatus?.value === 'active'){
		dhw_exists = true;
		dhw_image = "/static/img/vitocal/Warmwasserspeicher%20ein.png"; // dhw is heating
	}

    // Check if heating circuit is active
    const heatingActive = keyFeatures.operatingMode?.value === 'heating' ||
                         keyFeatures.operatingMode?.value === 'dhwAndHeating';

    // Check if electric heater (Heizstab) is active
    // This would typically be a secondary heater or backup heater
    const heaterActive = keyFeatures.secondaryHeater?.value === 'on' ||
                        keyFeatures.secondaryHeater?.value === true ||
                        keyFeatures.secondaryHeatGeneratorStatus?.value === 'on';

    // Calculate compressor speed with percentage if device settings available
    let compressorSpeedValue = null;
    let compressorSpeedUnit = '';
    if (keyFeatures?.compressorSpeed && (typeof keyFeatures.compressorSpeed.value === 'number')) {
        let speedValue = keyFeatures.compressorSpeed.value;
        const speedUnit = keyFeatures.compressorSpeed.unit;

        // Convert revolutionsPerSecond to RPM
        if (speedUnit === 'revolutionsPerSecond') {
            speedValue = speedValue * 60;
        }

	    // Calculate RPM percentage from device settings
        let rpmPercentage = null;
        if (deviceSetting && deviceSetting.max > deviceSetting.min && speedValue > 0) {
            rpmPercentage = Math.round(((speedValue - deviceSetting.min) / (deviceSetting.max - deviceSetting.min)) * 100);
            rpmPercentage = Math.max(0, Math.min(100, rpmPercentage));
        }

        // Use percentage if available, otherwise RPM
        if (rpmPercentage !== null) {
            compressorSpeedValue = rpmPercentage;
            compressorSpeedUnit = '%';
        } else {
            compressorSpeedValue = speedValue;
            compressorSpeedUnit = 'RPM';
        }
    }

    // Map values according to Mapping.png
    const values = {
        // A: Lüfter 1 (Drehzahl Ventilator 1)
        fan1: validate (keyFeatures.fan0),
        // B: Lüfter 2 (Drehzahl Ventilator 2)
        fan2: validate (keyFeatures.fan1),
        // C: Verdampfer Überhitzung (Flüssiggastemperatur kühlen)
        evaporatorOverheat: validate (keyFeatures.evaporatorOverheat),
        // D: Öffnungsweite elektr. Expansionsventil
        expansionValve1: validate (keyFeatures.expansionValve_0),
        // E: Economizer (Sauggastemperatur Heizen)
        economizer: validate (keyFeatures.economizerTemp),
        // F: Öffnungsweite des elektr. Expansionsventil 2
        expansionValve2: validate (keyFeatures.expansionValve_1),
        // G: Verdampfer Überhitzung (Sauggastemperatur Verdampfer)
        evaporatorTemp: validate(keyFeatures.evaporatorTemp),
        // H: Verflüssiger (Flüssigkeitgrad Verflüssiger)
        condensorTemp: validate (keyFeatures.condensorTemp),
        // K: Heizkreis Rücklauftemperatur (Rücklauf Sekundärkreis)
        returnTemp: validate (keyFeatures.returnTemp),
        // L: Interne Pumpe (Drehzahl Sekundärpumpe)
        pumpInternal: validate (keyFeatures.pumpInternal),
        // M: Vorlauftemperatur (Vorlauftemperatur IDU)
        supplyTemp: validate (keyFeatures.supplyTemp),
        // M2: Vorlauftemperatur (Vorlauftemperatur ODU Sekundärkreis)
        supplyTempSec: validate (keyFeatures.secondarySupplyTemp),
        // N: 4/3-Wege-Ventil (4-Wege Ventil Kältekreis)
        fourWayValve: validate (keyFeatures.fourWayValve),
        // O: Einlassdruck (Saugasdruck Verdichter)
        compressorPressure: validate (keyFeatures.compressorPressure),
        // P: Verflüssigungsdruck (not available via API)
        condensingPressure: null,
        // R: Einlasstemperatur (Sauggastemperatur Verdichter)
        compressorInletTemp: validate (keyFeatures.compressorInletTemp),
        // S: Auslasstemperatur (Heissgastemperatur)
        compressorOutletTemp: validate (keyFeatures.compressorOutletTemp),
        // T: Drehzahl Verdichter (RPM oder % je nach Konfiguration)
        compressorSpeed: compressorSpeedValue,
        compressorSpeedUnit: compressorSpeedUnit,
        // U: Öltemperatur (Verdichtertemperatur)
        compressorOilTemp: validate (keyFeatures.compressorOilTemp),
        // V: Betriebsart
        operatingMode: validate (keyFeatures.operatingMode),
        // W: Lufteintrittstemperatur Verdampfer (Primärkreis-Vorlauf)
        airIntakeTemp: validate (keyFeatures.primarySupplyTemp),
        // W2: Außentemperatur
        outsideTemp: validate (keyFeatures.outsideTemp),
        // X: Volumenstrom
        volumetricFlow: validate (keyFeatures.volumetricFlow),
        // Y: Druck
        pressure: validate (keyFeatures.pressure),
		dhwTemp:  validate (keyFeatures.dhwTemp),
		compressorPower:  validate (keyFeatures.compressorPower),
		
    };

	// validate bufferTemp, option: bufferTempTop
    let bufferTempVal = null;
    if (keyFeatures.bufferTemp !== null){
    	const bufferTempValue = keyFeatures.bufferTemp.value;
        if ( typeof bufferTempValue === 'number'){
            bufferTempVal = bufferTempValue;
        }
    }
    if (bufferTempVal == null && keyFeatures.bufferTempTop !== null){
    	const bufferTempTopValue = keyFeatures.bufferTempTop.value;
        if ( typeof bufferTempTopValue === 'number'){
            bufferTempVal = bufferTempTopValue;
        }
    }

    // Format value with unit
    const formatValue = (value, unit = '', decimals = 1) => {
        if (value === null || value === undefined) return '-';
        if (typeof value === 'number') {
            return value.toFixed(decimals) + (unit ? ' ' + unit : '');
        }
        return value;
    };

    // Calculate thermal power if all required values are available
    let thermalPowerW = null;
    if (keyFeatures.volumetricFlow?.value) {
        // Use central spreizung calculation
        const spreizungResult = calculateSpreizung(keyFeatures, hasHotWaterBuffer);

        if (spreizungResult.isValid) {
            const waterDensity = getWaterDensity(spreizungResult.supplyTemp); // kg/m³
            const specificHeatCapacity = 4180; // J/(kg·K)
            const volumetricFlowM3s = keyFeatures.volumetricFlow.value / 3600000; // l/h to m³/s
            const massFlow = waterDensity * volumetricFlowM3s; // kg/s
            thermalPowerW = massFlow * specificHeatCapacity * spreizungResult.spreizung; // W
        }
    }

    return `
            <div class="refrigerant-visual-container">
                <div class="refrigerant-diagram">
                    <img src="${baseImage}" alt="Kältekreislauf" class="base-diagram">

                    <!-- Component overlays with status images -->
                    <!-- DHW Storage -->
                    ${dhw_exists ? `
                    <img src="${dhw_image}"
                         alt="Warmwasserspeicher" class="component-overlay dhw-storage-overlay">
                    ` : ''}

                    <!-- Heating Storage -->
                    <img src="/static/img/vitocal/Heizwasserspeicher%20${heatingActive ? 'ein' : 'aus'}.png"
                         alt="Heizwasserspeicher" class="component-overlay heating-storage-overlay">

                    <!-- Electric Heater (Heizstab) -->
                    ${heaterActive ? `
                    <img src="/static/img/vitocal/Heizstab%20ein.png" alt="Heizstab aktiv" class="component-overlay heater-overlay">
                    ` : `
                    <img src="/static/img/vitocal/Heizstab%20aus.png" alt="Heizstab aus" class="component-overlay heater-overlay">
                    `}

                    <!-- Individual value overlays with tooltips -->
                    <!-- Alle Positionen basierend auf View-Größe 847x363px -->
                    ${values.fan1 !== null ? `<div class="value-label" style="top: 51.52%; left: 8.03%;" title="Lüfter 1">${formatValue(values.fan1, '%', 0)}</div>` : ''}
                    ${values.fan2 !== null ? `<div class="value-label" style="top: 22.87%; left: 8.03%;" title="Lüfter 2">${formatValue(values.fan2, '%', 0)}</div>` : ''}

                    ${values.evaporatorTemp !== null ? `<div class="value-label" style="top: 37.19%; left: 21.72%;" title="Verdampfer Temperatur">${formatValue(values.evaporatorTemp, '°C')}</div>` : ''}
                    ${values.evaporatorOverheat !== null ? `<div class="value-label" style="top: 37.19%; left: 56.79%;" title="Verdampfer Überhitzung">${formatValue(values.evaporatorOverheat, '°C')}</div>` : ''}

                    ${values.economizer !== null ? `<div class="value-label" style="top: 17.36%; left: 38.72%;" title="Economizer">${formatValue(values.economizer, '°C')}</div>` : ''}

                    ${values.compressorSpeed !== null ? `<div class="value-label" style="top: 71.35%; left: 38.61%;" title="Kompressor Drehzahl">${formatValue(values.compressorSpeed, values.compressorSpeedUnit, 0)}</div>` : ''}
                    ${values.compressorInletTemp !== null ? `<div class="value-label" style="top: 69.70%; left: 47.93%;" title="Kompressor Einlasstemperatur">${formatValue(values.compressorInletTemp, '°C')}</div>` : ''}
                    ${values.compressorOutletTemp !== null ? `<div class="value-label" style="top: 93.94%; left: 38.84%;" title="Kompressor Auslasstemperatur">${formatValue(values.compressorOutletTemp, '°C')}</div>` : ''}
                    ${values.compressorOilTemp !== null ? `<div class="value-label" style="top: 52.62%; left: 32.35%;" title="Kompressor Öltemperatur">${formatValue(values.compressorOilTemp, '°C')}</div>` : ''}
                    ${values.compressorPressure !== null ? `<div class="value-label" style="top: 69.70%; left: 56.43%;" title="Kompressor Einlassdruck">${formatValue(values.compressorPressure, 'bar')}</div>` : ''}
                    ${values.expansionValve1 !== null ? `<div class="value-label" style="top: 17.36%; left: 58%;" title="Ventil">${formatValue(values.expansionValve1, '%')}</div>` : ''}
                    ${values.expansionValve2 !== null ? `<div class="value-label" style="top: 37.20%; left: 33%;" title="Ventil">${formatValue(values.expansionValve2, '%')}</div>` : ''}

                    ${values.condensorTemp !== null  ? `<div class="value-label" style="top: 17.36%; left: 66.47%;" title="Verflüssiger">${formatValue(values.condensorTemp, '°C')}</div>` : ''}

                    ${values.returnTemp !== null ? `<div class="value-label" style="top: 17.36%; left: 83.83%;" title="Rücklauftemperatur">${formatValue(values.returnTemp, '°C')}</div>` : ''}
                    ${values.pressure !== null ? `<div class="value-label" style="top: 22.87%; left: 83.83%;" title="Druck">${formatValue(values.pressure, 'bar')}</div>` : ''}
                    ${values.supplyTempSec !== null ? `<div class="value-label" style="top: 83.75%; left: 82.0%;" title="ODU sekundär Vorlauftemperatur">${formatValue(values.supplyTempSec, '°C')}</div>` : ''}
                    ${values.supplyTemp !== null ? `<div class="value-label" style="top: 83.75%; left: 88.0%;" title="IDU Vorlauftemperatur">${formatValue(values.supplyTemp, '°C')}</div>` : ''}
                    ${values.pumpInternal !== null ? `<div class="value-label" style="top: 22.87%; left: 95.0%;" title="Interne Pumpe">${formatValue(values.pumpInternal, '%', 0)}</div>` : ''}

                    ${values.airIntakeTemp !== null ? `<div class="value-label" style="top: 44.35%; left: 0.71%;" title="Lufteintrittstemperatur">${formatValue(values.airIntakeTemp, '°C')}</div>` : ''}
                    ${values.outsideTemp !== null ? `<div class="value-label" style="top: 48.35%; left: 0.71%;" title="Außentemperatur">${formatValue(values.outsideTemp, '°C')}</div>` : ''}
                    ${values.volumetricFlow !== null ? `<div class="value-label" style="top: 17.36%; left: 93.0%;" title="Volumenstrom">${formatValue(values.volumetricFlow, 'l/h', 0)}</div>` : ''}

                    <!-- Speichertemperaturen (unter den Speicher-Bildern) -->
                    ${bufferTempVal !== null ? `<div class="value-label" style="top: 64.74%; left: 84.65%;" title="Heizpuffer Temperatur">${formatValue(bufferTempVal, '°C')}</div>` : ''}
                    ${values.dhwTemp !== null ? `<div class="value-label" style="top: 64.74%; left: 91.26%;" title="Warmwasser Temperatur">${formatValue(values.dhwTemp, '°C')}</div>` : ''}

                    <!-- Leistungsanzeigen -->
                    ${values.compressorPower !== null  ? `<div class="value-label" style="top: 55.37%; left: 43.68%;" title="Elektrische Leistung Kompressor">${formatValue(values.compressorPower, 'W', 0)}</div>` : ''}
                    ${thermalPowerW !== null ? `<div class="value-label" style="top: 37.19%; left: 82.64%;" title="Thermische Leistung (berechnet)">${formatValue(thermalPowerW, 'W', 0)}</div>` : ''}
                </div>
            </div>
    `;
}


// use other picture for visual representation of the heat pump refrigerant cycle with real-time data overlay 
function renderOtherRefrigerantCircuitPic(keyFeatures, compressorActive = false, activeFeed = null) {
    const deviceInfo = window.currentDeviceInfo;
    const deviceKey = deviceInfo ? `${deviceInfo.installationId}_${deviceInfo.deviceId}` : null;
    const deviceSetting = deviceKey && window.deviceSettingsCache ? window.deviceSettingsCache[deviceKey] : null;
    const isVitocellView = deviceSetting?.useOtherRefrigerantPic === true || isVitocal200G(deviceInfo, keyFeatures);
	
    // Select base image (active or inactive)
    let baseImage = '/static/img/vitocal/WMPrefrigerant.jpg';
	
	    // Check if DHW is active (heating domestic hot water)
	let dhw_exists = false;
	let dhw_image =  ""; // no dhw 
    // Check if DHW exists or on intended temperature or is active (heating domestic hot water)
	if (keyFeatures.dhwStatus?.value === 'off' || keyFeatures.dhwStatus?.value === 'inactive'){
		dhw_exists = true;
		dhw_image = "/static/img/vitocal/Warmwasserspeicher%20aus.png"; // dhw is off 
	} else{
	  if (keyFeatures.dhwTemp?.value && keyFeatures.dhwTarget?.value){
		dhw_exists = true;
		dhw_image = "/static/img/vitocal/Warmwasserspeicher%20temp.png"; // dhw has intended temp
		if ( keyFeatures?.dhwHysteresisSwitchOn?.value ){
			if (keyFeatures.dhwTemp.value <= (keyFeatures.dhwTarget.value - keyFeatures.dhwHysteresisSwitchOn.value)){
				dhw_image = "/static/img/vitocal/Warmwasserspeicher_cold.png"; // dhw has low temp
			}
		}
	  } 
	}
    if (keyFeatures.dhwStatus?.value === 'on' || keyFeatures.dhwStatus?.value === 'active'){
		dhw_exists = true;
		dhw_image = "/static/img/vitocal/Warmwasserspeicher%20ein.png"; // dhw is heating
	}

    // Calculate compressor speed with percentage if device settings available
    let compressorSpeedValue = null;
    let compressorSpeedUnit = '';
    if (keyFeatures?.compressorSpeed && (typeof keyFeatures.compressorSpeed.value === 'number')) {
        let speedValue = keyFeatures.compressorSpeed.value;
        const speedUnit = keyFeatures.compressorSpeed.unit;

        // Convert revolutionsPerSecond to RPM
        if (speedUnit === 'revolutionsPerSecond') {
            speedValue = speedValue * 60;
        }

        // Get device settings for RPM percentage calculation
        const deviceInfo = window.currentDeviceInfo;
        let rpmPercentage = null;
        if (deviceInfo && window.deviceSettingsCache) {
            const deviceKey = deviceInfo.installationId + '_' + deviceInfo.deviceId;
            const settings = window.deviceSettingsCache[deviceKey];
            if (settings && settings.max > settings.min){
				if (speedValue > 0) {
					rpmPercentage = Math.round(((speedValue - settings.min) / (settings.max - settings.min)) * 100);
					rpmPercentage = Math.max(0, Math.min(100, rpmPercentage));
				}
				else rpmPercentage = 0;
			}
        }

        // Use percentage if available, otherwise RPM
        if (rpmPercentage !== null) {
            compressorSpeedValue = rpmPercentage;
            compressorSpeedUnit = '%';
        } else {
            compressorSpeedValue = speedValue;
            compressorSpeedUnit = 'RPM';
        }
    }
	
    // Map values according to WMPrefrigerant.jpg (1299x547px)
    const values = {
        //  Verdampfer Flüssigtemperatur (tO)
        evaporatorTemp: validate(keyFeatures.evaporatorTemp),
        //  Verdampfer Überhitzung
        evaporatorOverheat: validate(keyFeatures.evaporatorOverheat),
        //  Heizkreis Rücklauftemperatur (Rücklauf Sekundärkreis)
        returnTemp: validate(keyFeatures.returnTemp),
        //  Vorlauftemperatur (Vorlauftemperatur ODU Sekundärkreis)
        supplyTempSec: validate(keyFeatures.secondarySupplyTemp),
        //  Einlassdruck (Saugasdruck Verdichter)
        compressorPressure: validate(keyFeatures.compressorPressure),
        //  Einlasstemperatur (Sauggastemperatur Verdichter)
        compressorInletTemp: validate(keyFeatures.compressorInletTemp),
        //  Auslasstemperatur (Heißgastemperatur Verdichter)
        compressorOutletTemp: validate(keyFeatures.compressorOutletTemp),
        //  Eintrittstemperatur Primärkreis (Sole-Eintritt)
        primarySupply: compressorActive ? validate(keyFeatures.primarySupplyTemp) : null,
        //  Austrittstemperatur Primärkreis (Sole-Austritt)
        primaryReturn: compressorActive ? validate(keyFeatures.primaryReturnTemp) : null,
        //  Außentemperatur
        outsideTemp: validate(keyFeatures.outsideTemp),
        //  Warmwasser
        dhwTemp: validate(keyFeatures.dhwTemp),
        // Sole-spezifisch: Heißgasdruck
        hotGasPressure: validate(keyFeatures.hotGasPressure),
        // Sole-spezifisch: Sauggasdruck
        suctionGasPressure: validate(keyFeatures.suctionGasPressure),
        // Sole-spezifisch: Heißgastemperatur
        hotGasTemp: validate(keyFeatures.hotGasTemp),
        // Sole-spezifisch: Sauggastemperatur
        suctionGasTemp: validate(keyFeatures.suctionGasTemp),
        // Sole-spezifisch: Flüssiggastemperatur
        liquidGasTemp: validate(keyFeatures.liquidGasTemp),
        // Sole-spezifisch: Primärkreis Pumpendrehzahl
        primaryRotation: compressorActive ? validate(keyFeatures.primaryRotation) : null,
    };


    // Format value with unit
    const formatValue = (value, unit = '', decimals = 1) => {
        if (value === null || value === undefined) return '-';
        if (typeof value === 'number') {
            return value.toFixed(decimals) + (unit ? ' ' + unit : '');
        }
        return value;
    };

    return `
            <div class="refrigerant-visual-container">
                <div class="refrigerant-diagram">
                    <img src="${baseImage}" alt="${isVitocellView ? 'Sole/Wasser-Kältekreislauf' : 'Kältekreislauf'}" class="base-diagram">

                    <!-- Component overlays with status images -->
                    <!-- DHW Storage -->
                    ${dhw_exists && !isVitocellView ? `
                    <img src="${dhw_image}"
                         alt="Warmwasserspeicher" class="component-overlay dhw-storage-overlay-left">
                    ` : ''}

                    <!-- Individual value overlays with tooltips -->
                    <!-- Alle Positionen basierend auf WMPrefrigerant.jpg 1299x547px -->

                    ${values.compressorInletTemp !== null ? `<div class="value-label" style="top: 18.00%; left: 55.00%;" title="Kompressor Einlasstemperatur">${formatValue(values.compressorInletTemp, '°C')}</div>` : ''}
                    ${values.compressorPressure !== null ? `<div class="value-label" style="top: 23.00%; left: 55.00%;" title="Kompressor Einlassdruck">${formatValue(values.compressorPressure, 'bar')}</div>` : ''}
                    ${values.compressorOutletTemp !== null ? `<div class="value-label" style="top: 18.00%; left: 39.00%;" title="Kompressor Auslasstemperatur">${formatValue(values.compressorOutletTemp, '°C')}</div>` : ''}

                    ${values.returnTemp !== null ? `<div class="value-label" style="top: 84.00%; left: 15.00%;" title="Rücklauftemperatur sekundär">${formatValue(values.returnTemp, '°C')}</div>` : ''}
                    ${values.supplyTempSec !== null ? `<div class="value-label" style="top: 16.00%; left: 15.00%;" title="Vorlauftemperatur sekundär">${formatValue(values.supplyTempSec, '°C')}</div>` : ''}

                    ${values.evaporatorTemp !== null ? `<div class="value-label" style="top: 59.09%; left: 85.39%;" title="Verdampfer Flüssigtemperatur (tO)">tO:${formatValue(values.evaporatorTemp, '°C')}</div>` : ''}
                    ${values.evaporatorOverheat !== null ? `<div class="value-label" style="top: 50.00%; left: 85.00%;" title="Verdampfer Überhitzung">${formatValue(values.evaporatorOverheat, '°C')}</div>` : ''}
                    ${values.primarySupply !== null ? `<div class="value-label" style="top: 16.00%; left: 80.00%;" title="Eintrittstemperatur Primärkreis (Sole)">${formatValue(values.primarySupply, '°C')}</div>` : ''}
                    ${values.primaryReturn !== null ? `<div class="value-label" style="top: 84.00%; left: 80.00%;" title="Austrittstemperatur Primärkreis (Sole)">${formatValue(values.primaryReturn, '°C')}</div>` : ''}
                    ${values.outsideTemp !== null ? `<div class="value-label" style="top: 49.00%; left: 92.00%;" title="Außentemperatur">${formatValue(values.outsideTemp, '°C')}</div>` : ''}

                    <!-- Sole-spezifische Sensoren -->
                    ${values.hotGasPressure !== null ? `<div class="value-label" style="top: 52.49%; left: 55.23%;" title="Heißgasdruck">${formatValue(values.hotGasPressure, 'bar')}</div>` : ''}
                    ${values.suctionGasPressure !== null ? `<div class="value-label" style="top: 44.14%; left: 55.31%;" title="Sauggasdruck">${formatValue(values.suctionGasPressure, 'bar')}</div>` : ''}
                    ${values.hotGasTemp !== null ? `<div class="value-label" style="top: 25.16%; left: 39.08%;" title="Heißgastemperatur">${formatValue(values.hotGasTemp, '°C')}</div>` : ''}
                    ${values.suctionGasTemp !== null ? `<div class="value-label" style="top: 12.00%; left: 55.00%;" title="Sauggastemperatur">${formatValue(values.suctionGasTemp, '°C')}</div>` : ''}
                    ${values.liquidGasTemp !== null ? `<div class="value-label" style="top: 81.86%; left: 39.44%;" title="Flüssiggastemperatur">${formatValue(values.liquidGasTemp, '°C')}</div>` : ''}
                    ${values.primaryRotation !== null ? `<div class="value-label" style="top: 38.67%; left: 93.48%;" title="Primärkreis Pumpendrehzahl">${formatValue(values.primaryRotation, '%', 0)}</div>` : ''}

                    <!-- Speichertemperaturen (unter den Speicher-Bildern) -->
                    ${values.dhwTemp !== null && !isVitocellView ? `<div class="value-label" style="top: 65.00%; left: 4.50%;" title="Warmwasser Temperatur">${formatValue(values.dhwTemp, '°C')}</div>` : ''}

                </div>
                ${isVitocellView ? renderVitocellHydraulics(keyFeatures, compressorActive, activeFeed) : ''}
            </div>
    `;
}

