import NiceHashProvider from '../src/RentalProviders/NiceHashProvider';
import { config } from 'dotenv'
config()

const apikey = {
	key: process.env.NICEHASH_API_KEY,
	id: process.env.NICEHASH_API_ID
};

describe('NiceHashProvider', () => {
	describe('Setup', () => {
		it('test authorization', async () => {
			let api = new NiceHashProvider(apikey)
			expect(await api.testAuthorization()).toBeTruthy()
		})
		it('get balance', async () => {
			let api = new NiceHashProvider(apikey);
			expect(typeof await api._getBalance() === 'number')
		})
	});
})
