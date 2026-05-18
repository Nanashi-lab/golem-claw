import { BaseAgent, Config, agent } from '@golemcloud/golem-ts-sdk';
import type { TelegramConfig } from './gemini';

type SavedLocation = {
  name: string;
  country: string;
  state?: string;
  lat: number;
  lon: number;
};

export type WeatherResult = {
  tool: 'setCity' | 'getWeatherForCity';
  ok: boolean;
  summary: string;
  location?: SavedLocation;
  weather?: {
    temperatureC: number;
    feelsLikeC: number;
    humidity: number;
    description: string;
    windSpeedMs: number;
  };
};

type MutationResult = {
  key: string;
  result: WeatherResult;
};

const MUTATION_RESULT_LIMIT = 100;

@agent()
export class WeatherAgent extends BaseAgent {
  private location?: SavedLocation;
  private mutationResults: MutationResult[] = [];

  constructor(readonly botName: string, readonly chatId: string, readonly config: Config<TelegramConfig>) {
    super();
  }

  async setCity(city: string, updateKey?: string): Promise<WeatherResult> {
    const existing = this.getMutationResult(updateKey);
    if (existing) {
      return existing;
    }

    const resolved = await this.resolveCity(city);
    let result: WeatherResult;

    if (!resolved) {
      result = {
        tool: 'setCity',
        ok: false,
        summary: `I could not find a city matching ${city}.`,
      };
    } else {
      this.location = resolved;
      result = {
        tool: 'setCity',
        ok: true,
        summary: `Saved city as ${this.formatLocation(resolved)}.`,
        location: resolved,
      };
    }

    this.saveMutationResult(updateKey, result);
    return result;
  }

  async getWeatherForCity(city: string): Promise<WeatherResult> {
    const trimmed = city.trim();
    const resolved = trimmed.length === 0 ? this.location : await this.resolveCity(trimmed);
    if (!resolved) {
      return {
        tool: 'getWeatherForCity',
        ok: false,
        summary: trimmed.length === 0
          ? 'No default city is set yet. Please set a city first.'
          : `I could not find a city matching ${city}.`,
      };
    }

    return this.fetchWeatherForLocation('getWeatherForCity', resolved);
  }

  async getCity(): Promise<SavedLocation | undefined> {
    return this.location;
  }

  private async resolveCity(city: string): Promise<SavedLocation | undefined> {
    const trimmed = city.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    const response = await fetch(
      `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(trimmed)}&limit=1&appid=${this.config.value.weatherApiKey.get()}`
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

  private async fetchWeatherForLocation(
    tool: WeatherResult['tool'],
    location: SavedLocation
  ): Promise<WeatherResult> {
    const response = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?lat=${location.lat}&lon=${location.lon}&appid=${this.config.value.weatherApiKey.get()}&units=metric`
    );

    if (!response.ok) {
      throw new Error(`OpenWeather weather lookup failed: ${response.status} ${await response.text()}`);
    }

    const data = (await response.json()) as {
      weather?: Array<{ description?: string }>;
      main?: { temp?: number; feels_like?: number; humidity?: number };
      wind?: { speed?: number };
      name?: string;
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
      return {
        tool,
        ok: false,
        summary: `OpenWeather returned incomplete weather data for ${this.formatLocation(location)}.`,
        location,
      };
    }

    const weather = {
      temperatureC,
      feelsLikeC,
      humidity,
      description,
      windSpeedMs,
    };

    return {
      tool,
      ok: true,
      summary: `${this.formatLocation(location)} is ${weather.description} at ${weather.temperatureC}C, feels like ${weather.feelsLikeC}C, humidity ${weather.humidity}%, wind ${weather.windSpeedMs} m/s.`,
      location,
      weather,
    };
  }

  private formatLocation(location: SavedLocation): string {
    return [location.name, location.state, location.country].filter(Boolean).join(', ');
  }

  private getMutationResult(updateKey: string | undefined): WeatherResult | undefined {
    if (!updateKey) {
      return undefined;
    }

    return this.mutationResults.find((entry) => entry.key === updateKey)?.result;
  }

  private saveMutationResult(updateKey: string | undefined, result: WeatherResult): void {
    if (!updateKey) {
      return;
    }

    this.mutationResults.push({ key: updateKey, result });
    if (this.mutationResults.length > MUTATION_RESULT_LIMIT) {
      this.mutationResults.shift();
    }
  }
}
