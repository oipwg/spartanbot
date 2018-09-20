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
		let success = await mrr.testAuthorization();
		expect(success).toBeTruthy()
	});
	it('should get my profile ID | getProfileID', async () => {
		let mrr = new MRRProvider(apikey);
		let profileID = await mrr.getProfileID();
		expect(typeof profileID === 'number').toBeTruthy()
	});
	it('get default account balance (BTC) | getBalance', async () => {
		let mrr = new MRRProvider(apikey);
		let balance = await mrr.getBalance();
		expect(typeof balance === 'number').toBeTruthy()
	});
	it('get account balance for another coin| getBalance', async () => {
		let mrr = new MRRProvider(apikey);
		let balance = await mrr.getBalance('ltc');
		expect(typeof balance === 'number').toBeTruthy()
	});
	it('get all balances | getBalances', async () => {
		let mrr = new MRRProvider(apikey);
		let balance = await mrr.getBalances();
		expect(balance.success === undefined).toBeTruthy()
	});
	it('should fetch qualified rigs| getRigsToRent', async () =>{
		let mrr = new MRRProvider(apikey);
		let hashMh = 10001, duration = 5;
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

	});
	it('rent rigs', async () => {
		let mrr = new MRRProvider(apikey);
		let rentOptions = {
			hashrate: 500,
			duration: 3,
			confirm: confirmFn
		}
		let rentalConfirmation = await mrr.rent(rentOptions);
		let success;
		if (rentalConfirmation.info === 'Rental Cancelled') {
			success = true
		} else if (rentalConfirmation.success) {
			success = true
		} else {
			success = false
		}
		expect(success).toBeTruthy()
		// console.log('rental confirmation: ', rentalConfirmation)
	}, 250 * 1000);
	it.skip('rent rigs with insufficient balance (set manually) | rent', async () => {
		//must set balance manually in rent function to test
		let mrr = new MRRProvider(apikey);
		let response = await mrr.rent({
			hashrate: 5000,
			duration: 5,
			confirm: confirmFn
		})
		// console.log(response)
	});
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
		let response = await mrr.createPool(options)
		expect(response.success).toBeTruthy()
		// console.log(response)
	}, 250 * 1000);
	it('get all pools | getPools', async () => {
		let mrr = new MRRProvider(apikey);
		let response = await mrr.getPools()
		expect(response.success).toBeTruthy()
	});
	it('get pools by ID| getPools', async () => {
		let mrr = new MRRProvider(apikey);
		let ids = [176897, 176889]
		let response = await mrr.getPools(ids)
		// console.log(response)
		expect(response.success).toBeTruthy()
	});
})

let confirmFn = async (data) => {
	return false
	// setTimeout( () => {
	// 	Promise.resolve(true)
	// }, 2000)
}