import NiceHash from '../src/RentalProviders/NiceHashProvider';
import { config } from 'dotenv'
config()

const apikey = {
	key: process.env.NICEHASH_API_KEY,
	id: process.env.NICEHASH_API_ID
};

describe('NiceHashProvider', () => {
	describe('Setup', () => {
		it('test authorization', async () => {
			let api = new NiceHash(apikey.key, apikey.id)
			expect(await api.testAuthorization()).toBeTruthy()
		})
	})
})
