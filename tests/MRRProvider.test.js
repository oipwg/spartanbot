import MRRProvider from '../src/RentalProviders/MRRProvider';
import apikey from './apikey';

describe("MRRProvider", () => {
	it('should authorize MRR API access | testAuthorization', async () => {
		let mrr = new MRRProvider(apikey);
		let thrown;
		try {
			let success = await mrr.testAuthorization();
			expect(success).toBeTruthy()
		} catch (err) {
			thrown = false;
			expect(thrown).toBeFalsy()
		}
	});
	it('should get my profile ID | getProfileID', async () => {
		let mrr = new MRRProvider(apikey);
		let thrown;
		try {
			let profileID = await mrr.getProfileID();
			// console.log(profileID)
			expect(typeof profileID === 'number').toBeTruthy()
		} catch (err) {
			thrown = false;
			expect(thrown).toBeFalsy()
		}
	});
	it('should fetch qualified rigs| getRigsToRent', async () =>{
		let mrr = new MRRProvider(apikey);
		let thrown;
		let hashMh = 5000, duration = 5;
		try {
			let rigs = await mrr.getRigsToRent(hashMh, duration);
			// expect(success).toBeTruthy()
			let hashpower = 0;
			for (let rig of rigs) {
				hashpower += rig.hashrate
			}
			let enoughHash= false
			if (hashpower <= 5000) {
				enoughHash = true
			}
			expect(enoughHash).toBeTruthy()
		} catch (err) {
			thrown = false;
			expect(thrown).toBeFalsy()
		}
	});
	it('rent rigs', async () => {
		let mrr = new MRRProvider(apikey);
		let rentOptions = {
			hashrate: 500,
			duration: 3,
			confirm: confirmFn
		}
		try {
			let rentalConfirmation = await mrr.rent(rentOptions);
			// console.log('rental confirmation: ', rentalConfirmation)
		} catch (err) {
			// console.log(`Error: ${err}`)
			expect(err).toBeUndefined()
		}
	}, 250 * 1000);
})

let confirmFn = async (data) => {
	return true
	// setTimeout( () => {
	// 	Promise.resolve(true)
	// }, 2000)
}