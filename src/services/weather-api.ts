// Wraps OpenWeather geocoding and current-weather lookups.
import type { Secret } from '@golemcloud/golem-ts-sdk';

export type SavedLocation = {
  name: string;
  country: string;
  state?: string;
  lat: number;
  lon: number;
};

export type WeatherSnapshot = {
  temperatureC: number;
  feelsLikeC: number;
  humidity: number;
  description: string;
  windSpeedMs: number;
};

// Resolves a user-provided city string into one saved location record.
export async function resolveCity(apiKey: Secret<string>, city: string): Promise<SavedLocation | undefined> {
  const trimmed = city.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const response = await fetch(
    `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(trimmed)}&limit=1&appid=${apiKey.get()}`
  );

  if (!response.ok) {
    throw new Error(`OpenWeather geocoding failed: ${response.status} ${await response.text()}`);
  }

  const results = (await response.json()) as Array<{
    name: string;
    country: string;
    state?: string;
    lat: number;
    lon: number;
  }>;
  const match = results[0];
  if (!match) {
    return undefined;
  }

  return {
    name: match.name,
    country: match.country,
    state: match.state,
    lat: match.lat,
    lon: match.lon,
  };
}

// Fetches one current-weather snapshot for a resolved location.
export async function fetchWeatherForLocation(apiKey: Secret<string>, location: SavedLocation): Promise<WeatherSnapshot | undefined> {
  const response = await fetch(
    `https://api.openweathermap.org/data/2.5/weather?lat=${location.lat}&lon=${location.lon}&appid=${apiKey.get()}&units=metric`
  );

  if (!response.ok) {
    throw new Error(`OpenWeather weather lookup failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as {
    weather?: Array<{ description?: string }>;
    main?: { temp?: number; feels_like?: number; humidity?: number };
    wind?: { speed?: number };
  };

  const temperatureC = data.main?.temp;
  const feelsLikeC = data.main?.feels_like;
  const humidity = data.main?.humidity;
  const description = data.weather?.[0]?.description;
  const windSpeedMs = data.wind?.speed;

  if (
    typeof temperatureC !== 'number'
    || typeof feelsLikeC !== 'number'
    || typeof humidity !== 'number'
    || typeof description !== 'string'
    || typeof windSpeedMs !== 'number'
  ) {
    return undefined;
  }

  return {
    temperatureC,
    feelsLikeC,
    humidity,
    description,
    windSpeedMs,
  };
}

// Formats a saved location for chat responses and profile memory.
export function formatLocation(location: SavedLocation): string {
  return [location.name, location.state, location.country].filter(Boolean).join(', ');
}
