// Free sunrise lookup via api.sunrise-sunset.org.
// No auth, no key, returns ISO 8601 UTC when formatted=0.

import { SETTINGS } from '../settings.js';
import { info } from './logger.js';

// `date` = YYYY-MM-DD (UTC). Returns Date object for sunrise at our coords.
export async function getSunriseUtc(date) {
  const params = new URLSearchParams({
    lat: String(SETTINGS.locationLat),
    lng: String(SETTINGS.locationLon),
    date,
    formatted: '0',
  });
  const url = `${SETTINGS.sunriseApiUrl}?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sunrise API ${res.status}`);
  const json = await res.json();
  if (json.status !== 'OK') throw new Error(`sunrise API status: ${json.status}`);
  const sunrise = new Date(json.results.sunrise);
  info(`sunrise ${date} @ lat=${SETTINGS.locationLat},lon=${SETTINGS.locationLon}: ${sunrise.toISOString()}`);
  return sunrise;
}

// Decide whether `now` (Date) falls inside the send window.
// Window = [sunrise - preSunriseMinutes - tolerance, sunrise - preSunriseMinutes + tolerance].
// Returns { inWindow: bool, target: Date, sunrise: Date, minutesUntilTarget: number }.
export async function checkSendWindow(now = new Date()) {
  const dateStr = now.toISOString().slice(0, 10);
  const sunrise = await getSunriseUtc(dateStr);
  const target = new Date(sunrise.getTime() - SETTINGS.preSunriseMinutes * 60 * 1000);
  const diffMin = (now.getTime() - target.getTime()) / 60000;
  const inWindow = Math.abs(diffMin) <= SETTINGS.toleranceMinutes;
  info(`now=${now.toISOString()}, target=${target.toISOString()}, diff=${diffMin.toFixed(1)}min, inWindow=${inWindow}`);
  return { inWindow, target, sunrise, minutesUntilTarget: -diffMin };
}
