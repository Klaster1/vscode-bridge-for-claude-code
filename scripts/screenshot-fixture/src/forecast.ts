export interface HourlyForecast {
	hour: string;
	temperature: number;
}

const cache = new Map<string, { at: number; hours: HourlyForecast[] }>();
const cacheMs = 10 * 60 * 1000;

export async function forecast(city: string): Promise<HourlyForecast[]> {
	const hit = cache.get(city);
	if (hit && Date.now() - hit.at < cacheMs) {
		return hit.hours;
	}
	const response = await fetch(`/forecast?city=${encodeURIComponent(city)}`);
	if (!response.ok) {
		throw new Error(`No forecast for ${city}`);
	}
	const hours = (await response.json()) as HourlyForecast[];
	cache.set(city, { at: Date.now(), hours });
	return hours;
}
