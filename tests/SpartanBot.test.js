import SpartanBot from '../src/SpartanBot'
import uid from 'uid'
import {config} from 'dotenv'
import AutoRenter from "../src/AutoRenter"
import {RentalFunctionFinish} from "../src/constants";

config()

const apikey = {
	api_key: process.env.MRR_API_KEY,
	api_secret: process.env.MRR_API_SECRET
};

const niceHashAPI = {
	api_id: process.env.NICEHASH_API_ID,
	api_key: process.env.NICEHASH_API_KEY
}

// After all the tests have run, remove the test data :)
afterAll(() => {
	require('./rm-test-data.js')
})

let spartan, autorenter, mrr, nh;

const setupProviders = async () => {
	spartan = new SpartanBot({memory: true})

	let mrrSetup = await spartan.setupRentalProvider({
		type: "MiningRigRentals",
		api_key: apikey.api_key,
		api_secret: apikey.api_secret,
		name: "MiningRigRentals"
	})
	mrr = mrrSetup.provider

	let nhSetup = await spartan.setupRentalProvider({
		type: "NiceHash",
		api_key: niceHashAPI.api_key,
		api_id: niceHashAPI.api_id,
		name: "NiceHash"
	})
	nh = nhSetup.provider

	autorenter = new AutoRenter({
		rental_providers: spartan.rental_providers
	})
}

describe("SpartanBot", () => {
	describe("Settings", () => {
		it("Should be able to set a setting", () => {
			let spartan = new SpartanBot({memory: true})

			spartan.setSetting("test-setting", "test-setting-data")
			expect(spartan.settings['test-setting']).toBe("test-setting-data")
		})
		it("Should be able to get a setting", () => {
			let spartan = new SpartanBot({memory: true})

			spartan.setSetting("test-setting2", "test-setting-data2")
			expect(spartan.getSetting('test-setting2')).toBe("test-setting-data2")
		})
		it("Should be able to get settings", () => {
			let spartan = new SpartanBot({memory: true})

			spartan.setSetting("test-setting2", "test-setting-data2")
			expect(spartan.getSettings()).toEqual({"memory": true, "test-setting2": "test-setting-data2"})
		})
	})
	describe("RentalProviders", () => {
		it("Should be able to setup new MRR RentalProvider", async () => {
			let spartan = new SpartanBot({memory: true})

			let setup = await spartan.setupRentalProvider({
				type: "MiningRigRentals",
				api_key: apikey.api_key,
				api_secret: apikey.api_secret
			})

			expect(setup.success).toBe(true)
			expect(setup.type).toBe("MiningRigRentals")
		})
		it("Should be able to get supported rental provider type array", async () => {
			let spartan = new SpartanBot({memory: true})

			let providers = spartan.getSupportedRentalProviders()

			expect(providers).toEqual(["MiningRigRentals", "NiceHash"])
		})
		it("Should be able to get all rental providers", async () => {
			let spartan = new SpartanBot({memory: true})

			await spartan.setupRentalProvider({
				type: "MiningRigRentals",
				api_key: apikey.api_key,
				api_secret: apikey.api_secret
			})

			await spartan.setupRentalProvider({
				type: "MiningRigRentals",
				api_key: apikey.api_key,
				api_secret: apikey.api_secret
			})

			let providers = spartan.getRentalProviders()

			expect(providers.length).toBe(2)
		})
		it("Should be able to delete a rental provider", async () => {
			let spartan = new SpartanBot({memory: true})

			await spartan.setupRentalProvider({
				type: "MiningRigRentals",
				api_key: apikey.api_key,
				api_secret: apikey.api_secret
			})

			await spartan.setupRentalProvider({
				type: "MiningRigRentals",
				api_key: apikey.api_key,
				api_secret: apikey.api_secret
			})

			let providers = spartan.getRentalProviders()

			expect(providers.length).toBe(2)

			spartan.deleteRentalProvider(providers[0].getUID())

			let updated_providers = spartan.getRentalProviders()

			expect(updated_providers.length).toBe(1)
			expect(updated_providers[0].api_key).toBe(providers[1].api_key)
			expect(updated_providers[0].api_secret).toBe(providers[1].api_secret)
		})
	})
	describe('Multiple Providers', () => {
		it('setup both MRR and NiceHash', async (done) => {
			let spartan = new SpartanBot({memory: true});

			let nicehash = await spartan.setupRentalProvider({
				type: "NiceHash",
				api_key: niceHashAPI.api_key,
				api_id: niceHashAPI.api_id,
				name: "NiceHash"
			})

			let mrr = await spartan.setupRentalProvider({
				type: "MiningRigRentals",
				api_key: apikey.api_key,
				api_secret: apikey.api_secret,
				name: "MRR"
			})
			expect(nicehash.success).toBeTruthy()
			expect(mrr.success).toBeTruthy()
			done()
		})
		it('load providers from storage | deserialize', async (done) => {
			let spartan = new SpartanBot({memory: false})
			await spartan._deserialize
			await spartan._wallet_create

			await spartan.setupRentalProvider({
				type: "NiceHash",
				api_key: niceHashAPI.api_key,
				api_id: niceHashAPI.api_id,
				name: "NiceHash"
			})

			await spartan.setupRentalProvider({
				type: "MiningRigRentals",
				api_key: apikey.api_key,
				api_secret: apikey.api_secret,
				name: "MRR"
			})

			spartan.serialize()

			let spartan2 = new SpartanBot()

			// Wait for deserialization to finish
			await spartan2._deserialize
			await spartan2._wallet_login

			expect(spartan.getRentalProviders()[0].uid).toEqual(spartan2.getRentalProviders()[0].uid)

			done()
		})
	})
	describe('Pools', () => {
		it('create a global pool (1 provider)', async (done) => {
			let spartan = new SpartanBot({memory: true})

			await spartan.setupRentalProvider({
				type: "MiningRigRentals",
				api_key: apikey.api_key,
				api_secret: apikey.api_secret,
				name: "MRR"
			})

			let options = {
				algo: 'test',
				host: 'test',
				port: 7357,
				user: 'test',
				pass: 'test',
				name: 'test'
			}
			let poolID = await spartan.createPool(options)

			let match = false;

			for (let pool of spartan.returnPools()) {
				if (poolID === pool.id) {
					match = true
				}
			}
			expect(match).toBeTruthy()
			await spartan.deletePool(poolID)
			done()
		})
		it('create global pool (2 providers)', async (done) => {
			let spartan = new SpartanBot({memory: true})

			await spartan.setupRentalProvider({
				type: "NiceHash",
				api_key: niceHashAPI.api_key,
				api_id: niceHashAPI.api_id,
				name: "NiceHash"
			})

			await spartan.setupRentalProvider({
				type: "MiningRigRentals",
				api_key: apikey.api_key,
				api_secret: apikey.api_secret,
				name: "MRR"
			})

			let options = {
				algo: 'test',
				host: 'test',
				port: 7357,
				user: 'test',
				pass: 'test',
				name: 'test'
			}
			let poolID = await spartan.createPool(options)

			for (let p of spartan.getRentalProviders()) {
				let match = false
				for (let pool of p.returnPools()) {
					if (pool.name === options.name) {
						match = true
					}
				}
				expect(match).toBeTruthy()
			}
			await spartan.deletePool(poolID)
			done()
		})
		it('delete a global pool (2 providers)', async () => {
			let spartan = new SpartanBot({memory: true})

			await spartan.setupRentalProvider({
				type: "NiceHash",
				api_key: niceHashAPI.api_key,
				api_id: niceHashAPI.api_id,
				name: "NiceHash"
			})
			await spartan.setupRentalProvider({
				type: "MiningRigRentals",
				api_key: apikey.api_key,
				api_secret: apikey.api_secret,
				name: "MRR"
			})

			let options = {
				algo: 'test',
				host: 'test',
				port: 7357,
				user: 'test',
				pass: 'test',
				name: 'test'
			}
			let poolID = await spartan.createPool(options)
			let nh = spartan.getRentalProviders()[0]
			expect(nh.returnPools().length === 1)

			let mrrP = spartan.getRentalProviders()[1]
			let mrrPoolsLen = mrrP.returnPools().length

			await spartan.deletePool(poolID)

			expect(nh.returnPools().length === 0)
			expect(mrrP.returnPools().length).toEqual(mrrPoolsLen - 1)
		})
		it('create, update, and delete a pool', async (done) => {
			let spartan = new SpartanBot({memory: true})

			await spartan.setupRentalProvider({
				type: "NiceHash",
				api_key: niceHashAPI.api_key,
				api_id: niceHashAPI.api_id,
				name: "NiceHash"
			})
			await spartan.setupRentalProvider({
				type: "MiningRigRentals",
				api_key: apikey.api_key,
				api_secret: apikey.api_secret,
				name: "MRR"
			})

			let options = {
				algo: 'test',
				host: 'test',
				port: 7357,
				user: 'test',
				pass: 'test',
				name: 'test'
			}

			let poolID = await spartan.createPool(options)
			for (let provider of spartan.getRentalProviders()) {
				let checkFn = (id, name, provider) => {
					for (let pool of provider.returnPools()) {
						if (pool.id === id)
							expect(pool.name === name)
					}
				}
				checkFn(poolID, options.name, provider)
			}

			let newOptions = {
				algo: 'rest',
				host: 'rest',
				port: 7537,
				user: 'rest',
				pass: 'rest',
				name: 'rest'
			}

			await spartan.updatePool(poolID, newOptions)

			for (let provider of spartan.getRentalProviders()) {
				let checkFn = (id, name, provider) => {
					for (let pool of provider.returnPools()) {
						if (pool.id === id)
							expect(pool.name === name)
					}
				}
				checkFn(poolID, newOptions.name, provider)
			}
			await spartan.deletePool(poolID)

			done()
		})
	})
	describe('Pool Profiles', () => {
		it('get pool profiles', async () => {
			let spartan = new SpartanBot({memory: true})

			await spartan.setupRentalProvider({
				type: "MiningRigRentals",
				api_key: apikey.api_key,
				api_secret: apikey.api_secret,
				name: "MRR"
			})

			let profs = await spartan.getPoolProfiles()
			console.log(profs)
			expect(profs.length > 0).toBeTruthy()
		})
		it('create and delete a pool profile', async () => {
			let spartan = new SpartanBot({memory: true})

			await spartan.setupRentalProvider({
				type: "MiningRigRentals",
				api_key: apikey.api_key,
				api_secret: apikey.api_secret,
				name: "MRR"
			})

			let name = 'test';
			let algo = 'scrypt'

			let create = await spartan.createPoolProfile(name, algo)
			let id = create[0].id

			let match = false
			for (let prof of spartan.returnPoolProfiles()) {
				if (prof.id === id)
					match = true
			}
			expect(match).toBeTruthy()

			let del = await spartan.deletePoolProfile(id)
			expect(del.success).toBeTruthy()
			match = false
			for (let prof of spartan.returnPoolProfiles()) {
				if (prof.id === id)
					match = true
			}
			expect(match).toBeFalsy()
		})
		it('return pool profiles', async () => {
			let spartan = new SpartanBot({memory: true})

			await spartan.setupRentalProvider({
				type: "MiningRigRentals",
				api_key: apikey.api_key,
				api_secret: apikey.api_secret,
				name: "MRR"
			})

			let p = spartan.returnPoolProfiles()
			expect(p.length > 0).toBeTruthy()
		})
	})
	describe("Save and Reload", () => {
		it("Should be able to Serialize & Deserialize", async () => {
			let spartan = new SpartanBot({test: "setting"})

			await spartan._deserialize
			await spartan._wallet_create

			let account_identifier = spartan.oip_account
			let wallet_mnemonic = spartan.wallet._account.wallet.mnemonic

			expect(spartan.wallet._storageAdapter._username).toBe(account_identifier)
			expect(spartan.wallet._account.wallet.mnemonic).toBe(wallet_mnemonic)

			await spartan.setupRentalProvider({
				type: "MiningRigRentals",
				api_key: apikey.api_key,
				api_secret: apikey.api_secret
			})

			spartan.serialize()

			let spartan2 = new SpartanBot()

			// Wait for deserialization to finish
			await spartan2._deserialize
			await spartan2._wallet_login

			expect(spartan2.oip_account).toBe(account_identifier)
			expect(spartan2.wallet._storageAdapter._username).toBe(account_identifier)
			expect(spartan2.wallet._account.wallet.mnemonic).toBe(wallet_mnemonic)

			expect(spartan2.getSetting('test')).toBe("setting")
		})
	});
	describe('Rent / Preprocess', () => {
		it('MiningRigRentals Preprocess | mrrPreprocessRent', async (done) => {
			await setupProviders()

			let rentOptions = {
				hashrate: 20000,
				duration: 5
			}
			let h = rentOptions.hashrate
			let max = h + 1000
			let min = h - 1000

			let response = await autorenter.mrrRentPreprocess(rentOptions)

			let hashfound = response.badges.query.hashrate_found
			let hashTest = hashfound >= min && hashfound <= max
			expect(hashTest).toBeTruthy()

			expect(response.badges.status.status !== "ERROR")

			done()
		}, 250 * 100);
		it('Preprocess Rent | rentPreprocess', async (done) => {
			await setupProviders()

			let rentOptions = {
				hashrate: 10000,
				duration: 3
			}

			let preprocess = await autorenter.rentPreprocess(rentOptions)

			let statusCheck = false;
			switch (preprocess.status) {
				case 'NORMAL':
				case 'LOW_BALANCE':
				case 'WARNING':
					statusCheck = true
					break
				default:
					break
			}
			expect(statusCheck).toBeTruthy()

			done()
		}, 250 * 100);
		it.skip('Create and Cancel NiceHash order | cutoff rental', async (done) => {
			await setupProviders()

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
				amount: 0.005,
				limit: .01,
				price: .500
			}
			let rental = await nh._rent(rentOptions)
			console.log(rental)
			autorenter.cutoffRental(rental.id, rental.uid, .035)

			done()
		})
		it.skip('Emit Manual Rent Strategy | manual rent', async (done) => {
			await setupProviders()
			await spartan.setupRentalStrategy({type: 'ManualRent'})

			//create test pool for NiceHash renting and get its id for later deletion
			let poolOpts = {
				algo: 'scrypt',
				host: 'thecoin.pw',
				port: 3978,
				user: 'orpheus.1',
				pass: 'x',
				name: 'created in spartanbot manual rent (new) test'
			}
			await spartan.createPool(poolOpts)
			let id;
			for (let p of spartan.getRentalProviders()) {
				for (let pool of p.returnPools()) {
					if (pool.name === poolOpts.name) {
						id = pool.id
					}
				}
			}
			function expectReceipts() {
				expect(spartan.returnReceipts().length === 1)
				spartan.emitter.off(RentalFunctionFinish)
			}
			spartan.emitter.on(RentalFunctionFinish, expectReceipts)

			let hashrate = 500
			let duration = 3

			spartan.manualRent(hashrate, duration, async (prepr, opts) => {
				console.log("prep: ", prepr)
				return {confirm: true, badges: prepr.badges[0], message: 'manual cancel'}
			})

			//delete pool
			let res = await spartan.deletePool(id)
			console.log("delete pool: ", res)
			expect(res.success).toBeTruthy()
			done()

		}, 250 * 100 * 100);
		it.skip('Emit Spot Rental Strategy | spot rent', async (done) => {
			await setupProviders()
			await spartan.setupRentalStrategy({type: 'SpotRental'})
			await spartan.setupRentalStrategy({type: 'SpartanSense'})
			spartan.spotRental()
			done()

		}, 250 * 100 * 100)
	})
})
