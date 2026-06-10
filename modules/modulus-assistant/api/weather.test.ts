import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { clearWeatherCache, geocode, fetchWeatherReport } from './weather.js';

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

test('weather geocode and forecast use short in-process caches', async () => {
  clearWeatherCache();
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    calls++;
    const url = String(input);
    if (url.includes('geocoding-api')) {
      return okJson({
        results: [{ latitude: 51.5, longitude: -0.1, name: 'London', country: 'United Kingdom' }],
      });
    }
    return okJson({
      current: {
        temperature_2m: 12,
        apparent_temperature: 11,
        weather_code: 3,
        wind_speed_10m: 8,
        relative_humidity_2m: 70,
      },
      daily: {
        time: ['2026-05-18'],
        weather_code: [3],
        temperature_2m_max: [15],
        temperature_2m_min: [8],
        precipitation_probability_max: [10],
      },
    });
  };
  try {
    assert.equal((await geocode('London'))?.name, 'London, United Kingdom');
    assert.equal((await geocode('london'))?.name, 'London, United Kingdom');
    assert.equal(calls, 1);

    await fetchWeatherReport(51.5, -0.1);
    await fetchWeatherReport(51.5, -0.1);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = origFetch;
    clearWeatherCache();
  }
});
