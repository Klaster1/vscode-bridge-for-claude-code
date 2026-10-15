export function total(prices: number[], discount: number): number {
	let sum = 0;
	for (const price of prices) {
		sum += price * (1 - discount);
	}
	return Math.round(sum * 100) / 100;
}

export const currency = 'USD';
