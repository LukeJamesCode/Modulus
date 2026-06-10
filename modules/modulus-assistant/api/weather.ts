// Open-Meteo geocoding + weather client. No API key required.

export const WMO_CODES: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Foggy',
  48: 'Icy fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  56: 'Light freezing drizzle',
  57: 'Freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Light showers',
  81: 'Showers',
  82: 'Heavy showers',
  85: 'Light snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm + hail',
  99: 'Thunderstorm + heavy hail',
};

export interface GeoResult {
  lat: number;
  lon: number;
  name: string;
}

export interface WeatherCurrent {
  conditionCode: number;
  condition: string;
  tempC: number;
  feelsLikeC: number;
  windKph: number;
  humidityPct: number;
}

export interface WeatherDay {
  date: string;
  conditionCode: number;
  condition: string;
  minC: number;
  maxC: number;
  precipPct: number;
}

export interface WeatherReport {
  locationName: string;
  current: WeatherCurrent;
  forecast: WeatherDay[];
}

const CACHE_TTL_MS = 10 * 60_000;
const geocodeCache = new Map<string, { expiresAt: number; value: Promise<GeoResult | null> }>();
const forecastCache = new Map<string, { expiresAt: number; value: Promise<WeatherReport> }>();

export function clearWeatherCache(): void {
  geocodeCache.clear();
  forecastCache.clear();
}

export async function geocode(
  location: string,
  opts: { signal?: AbortSignal; now?: () => number } = {},
): Promise<GeoResult | null> {
  const key = location.trim().toLowerCase();
  const now = opts.now?.() ?? Date.now();
  const cached = geocodeCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&format=json`;
  const value = (async () => {
    const res = await fetch(url, opts.signal ? { signal: opts.signal } : undefined);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      results?: Array<{ latitude: number; longitude: number; name: string; country: string }>;
    };
    if (!data.results?.length) return null;
    const r = data.results[0]!;
    return { lat: r.latitude, lon: r.longitude, name: `${r.name}, ${r.country}` };
  })();
  geocodeCache.set(key, { expiresAt: now + CACHE_TTL_MS, value });
  value.catch(() => geocodeCache.delete(key));
  return value;
}

export async function fetchWeatherReport(
  lat: number,
  lon: number,
  opts: { signal?: AbortSignal; now?: () => number } = {},
): Promise<WeatherReport> {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const now = opts.now?.() ?? Date.now();
  const cached = forecastCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    forecast_days: '4',
    timezone: 'auto',
  });
  const value = (async () => {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?${params.toString()}`,
      opts.signal ? { signal: opts.signal } : undefined,
    );
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    const d = (await res.json()) as {
      current: {
        temperature_2m: number;
        apparent_temperature: number;
        weather_code: number;
        wind_speed_10m: number;
        relative_humidity_2m: number;
      };
      daily: {
        time: string[];
        weather_code: number[];
        temperature_2m_max: number[];
        temperature_2m_min: number[];
        precipitation_probability_max: number[];
      };
    };
    const c = d.current;
    const current: WeatherCurrent = {
      conditionCode: c.weather_code,
      condition: WMO_CODES[c.weather_code] ?? 'Unknown',
      tempC: Math.round(c.temperature_2m),
      feelsLikeC: Math.round(c.apparent_temperature),
      windKph: Math.round(c.wind_speed_10m),
      humidityPct: c.relative_humidity_2m,
    };
    const forecast: WeatherDay[] = d.daily.time.map((date, i) => ({
      date,
      conditionCode: d.daily.weather_code[i]!,
      condition: WMO_CODES[d.daily.weather_code[i]!] ?? 'Unknown',
      minC: Math.round(d.daily.temperature_2m_min[i]!),
      maxC: Math.round(d.daily.temperature_2m_max[i]!),
      precipPct: d.daily.precipitation_probability_max[i] ?? 0,
    }));
    return { locationName: '', current, forecast };
  })();
  forecastCache.set(key, { expiresAt: now + CACHE_TTL_MS, value });
  value.catch(() => forecastCache.delete(key));
  return value;
}

export function formatReport(report: WeatherReport): string {
  const c = report.current;
  let out =
    `${c.condition} · ${c.tempC}°C (feels ${c.feelsLikeC}°C) · ` +
    `Wind ${c.windKph} km/h · Humidity ${c.humidityPct}%\n\nForecast:\n`;
  for (const day of report.forecast) {
    out += `  ${day.date}: ${day.condition}, ${day.minC}–${day.maxC}°C`;
    if (day.precipPct > 0) out += `, ${day.precipPct}% precip`;
    out += '\n';
  }
  return out;
}

export async function getWeather(
  location: string,
  opts: { signal?: AbortSignal } = {},
): Promise<string> {
  const geo = await geocode(location, opts);
  if (!geo) return `Could not geocode "${location}". Try a different city name.`;
  try {
    const report = await fetchWeatherReport(geo.lat, geo.lon, opts);
    report.locationName = geo.name;
    return `Weather for ${geo.name}:\n${formatReport(report)}`;
  } catch (e) {
    return `Failed to fetch weather: ${e instanceof Error ? e.message : String(e)}`;
  }
}
