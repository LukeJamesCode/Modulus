import type { Host } from '../../../src/core/modules.js';
import { getWeather } from '../api/weather.js';

const WEATHER_INTENT =
  '\\b(weather|temperature|forecast|rain|raining|snow|snowing|sunny|cloud|cloudy|wind|windy|hot|cold|degrees|celsius|fahrenheit|humid|humidity|outdoor|run|jog|walk|hike|workout|gym|good day (to|for))\\b';

export function register(host: Host): void {
  host.tools.register({
    name: 'weather_get',
    intentPattern: WEATHER_INTENT,
    description:
      'Get current weather conditions and a 4-day forecast for a city or region. ' +
      "Use for ANY weather question — current temp, 'will it rain', 'what's the forecast for Friday'. " +
      'Do NOT answer weather from training data; the model has no idea what today actually looks like — always call this tool. ' +
      'Powered by Open-Meteo (no API key, no auth).',
    tier: 'auto',
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description:
            'City name or region. Examples: "London", "New York", "Calgary". ' +
            'Omit to use the configured `default_location` setting.',
        },
      },
    },
    invoke: async (args, ctx) => {
      const a = args as { location?: string };
      const loc = a.location ?? host.settings.get<string>('default_location');
      if (!loc) return 'No location given and no default_location configured. Provide a city name.';
      return getWeather(loc, { signal: ctx.signal });
    },
  });
}
