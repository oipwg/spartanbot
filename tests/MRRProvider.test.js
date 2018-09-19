import MRRProvider from '../src/RentalProviders/MRRProvider';
import { config } from 'dotenv'
config()

const apikey = {
	api_key: process.env.API_KEY,
	api_secret: process.env.API_SECRET
};

describe("MRRProvider", () => {
	it('should authorize MRR API access | testAuthorization', async () => {
		let mrr = new MRRProvider(apikey);
		try {
			let success = await mrr.testAuthorization();
			expect(success).toBeTruthy()
		} catch (err) {
			expect(err).toBeUndefined()
		}
	});
	it('should get my profile ID | getProfileID', async () => {
		let mrr = new MRRProvider(apikey);
		try {
			let profileID = await mrr.getProfileID();
			expect(typeof profileID === 'number').toBeTruthy()
		} catch (err) {
			expect(err).toBeUndefined()
		}
	});
	it('get default account balance (BTC) | getBalance', async () => {
		let mrr = new MRRProvider(apikey);
		try {
			let balance = await mrr.getBalance();
			expect(typeof balance === 'number').toBeTruthy()
		} catch (err) {
			expect(err).toBeUndefined()
		}
	});
	it('get account balance for another coin| getBalance', async () => {
		let mrr = new MRRProvider(apikey);
		try {
			let balance = await mrr.getBalance('ltc');
			expect(typeof balance === 'number').toBeTruthy()
		} catch (err) {
			expect(err).toBeUndefined()
		}
	});
	it('get all balances | getBalances', async () => {
		let mrr = new MRRProvider(apikey);
		try {
			let balance = await mrr.getBalances();
			expect(balance.success === undefined).toBeTruthy()
		} catch (err) {
			expect(err).toBeUndefined()
		}
	});
	it('should fetch qualified rigs| getRigsToRent', async () =>{
		let mrr = new MRRProvider(apikey);
		let hashMh = 10000, duration = 5;
		try {
			let rigs = await mrr.getRigsToRent(hashMh, duration);
			// console.log(rigs)

			let hashpower = 0;
			for (let rig of rigs) {
				hashpower += rig.hashrate
			}
			// console.log(hashpower)
			let enoughHash= false
			if (hashpower <= hashMh) {
				enoughHash = true
			}
			expect(enoughHash).toBeTruthy()
		} catch (err) {
			expect(err).toBeUndefined()
		}
	});
	it('rent rigs', async () => {
		let mrr = new MRRProvider(apikey);
		let rentalCanceled = false;
		let rentOptions = {
			hashrate: 500,
			duration: 3,
			confirm: confirmFn
		}
		try {
			let rentalConfirmation = await mrr.rent(rentOptions);
			console.log('rental confirmation: ', rentalConfirmation)
		} catch (err) {
			// console.log(`Error: ${err}`)
			expect(err).toBeUndefined()
		}
	}, 250 * 1000);
	it('create pool and add it to profile | createPool', async () => {
		let mrr = new MRRProvider(apikey);
		let options = {
			profileName: 'SUPERRYAN',
			algo: 'scrypt',
			name: 'RYANSUPER',
			host: 'yadadadadaa',
			port: 8080,
			user: 'Lex Luther',
			priority: 0,
			notes: 'ryan wins!'
		};
		try {
			let response = await mrr.createPool(options)
			console.log(response)
		} catch (err) {
			console.log(`Err: \n ${err}`)
		}

	});
})

let confirmFn = async (data) => {
	return true
	// setTimeout( () => {
	// 	Promise.resolve(true)
	// }, 2000)
}