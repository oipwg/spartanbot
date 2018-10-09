import NiceHashProvider from '../src/RentalProviders/NiceHashProvider';
import { config } from 'dotenv'
config()

const apikey = {
	api_key: process.env.NICEHASH_API_KEY,
	api_id: process.env.NICEHASH_API_ID
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
	describe('Rent', () => {
		it('Manual Rent', async () => {
			let nh = new NiceHashProvider(apikey);

			let poolOptions = {
				algo: 'scrypt',
				host: 'snowflake.oip.fun',
				port: 3043,
				user: 'FAkFS9JonHkuZBhV9bbwXnsNRBwWSR5ve6',
				pass: 'x',
				location: 1,
				name: 'Ryans NH'
			}
			await nh.createPool(poolOptions)

			let rentOptions = {
				amount: 0.005,
				limit: .01,
				price: .500
			}

			console.log(await nh.manualRent(rentOptions))

		})
	})
})
