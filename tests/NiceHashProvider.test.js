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
		it('preprocess nicehash rent', async () => {
			let nh = new NiceHashProvider(apikey);

			let hashrate = 80000
			let duration = 3

			let preprocess = await nh.preprocessRent(hashrate, duration)
			console.log(preprocess)
			expect(preprocess.market).toEqual("NiceHash")
			expect(preprocess.status).toBeDefined()
			expect(preprocess.limit).toEqual(0.08)
			expect(preprocess.price).not.toBeNaN()
			expect(preprocess.amount).not.toBeNaN()
			expect(preprocess.duration).not.toBeNaN()
			expect(preprocess.balance).not.toBeNaN()
		});
		it.skip('Manual Rent', async () => {
			let nh = new NiceHashProvider(apikey);

			let poolOptions = {
				algo: 'scrypt',
				host: 'thecoin.pw',
				port: 3978,
				user: 'orpheus.1',
				pass: 'x',
				location: 1,
				name: 'Orpheus'
			}
			await nh.createPool(poolOptions)

			let rentOptions = {
				market: "NiceHash",
				amount: 0.005,
				limit: .01,
				price: .500
			}

			let nhOrder = await nh.rent(rentOptions)
			expect(nhOrder.success).toBeTruthy()
			// console.log('nhOrder: ', nhOrder)
		})
	})
})
