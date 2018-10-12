import SpartanBot from '../src/SpartanBot'
import uid from 'uid'
import { config } from 'dotenv'
import AutoRenter from "../src/AutoRenter"
config()

const apikey = {
	api_key: process.env.API_KEY,
	api_secret: process.env.API_SECRET
};

const apikey2 = {
	api_key: process.env.API_KEY_2,
	api_secret: process.env.API_SECRET_2
}

const ryansKey = {
	api_key: process.env.API_KEY_ORPHEUS,
	api_secret: process.env.API_SECRET_ORPHEUS
}

const niceHashAPI = {
	api_id: process.env.NICEHASH_API_ID,
	api_key: process.env.NICEHASH_API_KEY
}

const NiceHash = "NiceHash"
const MiningRigRentals = "MiningRigRentals"

// After all the tests have run, remove the test data :)
afterAll(() => {
	require('./rm-test-data.js')
})

let spartan, autorenter;

const setupProviders = async () => {
	spartan = new SpartanBot({ memory: true })

	await spartan.setupRentalProvider({
		type: "MiningRigRentals",
		api_key: apikey.api_key,
		api_secret: apikey.api_secret,
		name: "Master"
	})

	await spartan.setupRentalProvider({
		type: "NiceHash",
		api_key: niceHashAPI.api_key,
		api_id: niceHashAPI.api_id,
		name: "Ryan"
	})

	autorenter = new AutoRenter({
		rental_providers: spartan.rental_providers
	})
}

describe("SpartanBot", () => {
	describe("Settings", () => {
		it("Should be able to set a setting", () => {
			let spartan = new SpartanBot({ memory: true })

			spartan.setSetting("test-setting", "test-setting-data")
			expect(spartan.settings['test-setting']).toBe("test-setting-data")
		})
		it("Should be able to get a setting", () => {
			let spartan = new SpartanBot({ memory: true })

			spartan.setSetting("test-setting2", "test-setting-data2")
			expect(spartan.getSetting('test-setting2')).toBe("test-setting-data2")
		})
		it("Should be able to get settings", () => {
			let spartan = new SpartanBot({ memory: true })

			spartan.setSetting("test-setting2", "test-setting-data2")
			expect(spartan.getSettings()).toEqual({"memory": true, "test-setting2": "test-setting-data2"})
		})
	})

	describe("RentalProviders", () => {
		it("Should be able to setup new MRR RentalProvider", async () => {
			let spartan = new SpartanBot({ memory: true })

			let setup = await spartan.setupRentalProvider({
				type: "MiningRigRentals",
				api_key: apikey.api_key,
				api_secret: apikey.api_secret
			})

			expect(setup.success).toBe(true)
			expect(setup.type).toBe("MiningRigRentals")
		})
		it("Should be able to get supported rental provider type array", async () => {
			let spartan = new SpartanBot({ memory: true })

			let providers = spartan.getSupportedRentalProviders()

			expect(providers).toEqual(["MiningRigRentals"])
		})
		it("Should be able to get all rental providers", async () => {
			let spartan = new SpartanBot({ memory: true })

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
			let spartan = new SpartanBot({ memory: true })

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

	describe("Manual Rental", () => {
		/*
		it("Should be able to rent manually (no confirmation function)", async () => {
			let spartan = new SpartanBot({ memory: true })

			let rental = await spartan.manualRental(1000, 86400)

			expect(rental.success).toBe(true)
		})
		it("Should be able to use confirmation function", async () => {
			let spartan = new SpartanBot({ memory: true })

			let rental = await spartan.manualRental(1000, 86400, async (info) => {
				return true
			})

			expect(rental.success).toBe(true)
		})
		*/
		it("Should be able to cancel", async () => {
			let spartan = new SpartanBot({ memory: true })

			await spartan.setupRentalProvider({
				type: "MiningRigRentals",
				api_key: apikey.api_key,
				api_secret: apikey.api_secret
			})

			let rental = await spartan.manualRental(1000, 86400, async (info) => {
				return false
			})

			expect(rental.success).toBe(false)
			expect(rental.info).toBe("Rental Cancelled")
		})
	})

	describe("Save and Reload", () => {
		it("Should be able to Serialize & Deserialize", async () => {
			let spartan = new SpartanBot({ test: "setting" })

			await spartan._deserialize
			await spartan._wallet_create

			let account_identifier = spartan.oip_account
			let wallet_mnemonic = spartan.wallet._account.wallet.mnemonic

			expect(spartan.wallet._storageAdapter._username).toBe(account_identifier)
			expect(spartan.wallet._account.wallet.mnemonic).toBe(wallet_mnemonic)

			let setup = await spartan.setupRentalProvider({
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
		it('preprocess mrr rent | mrrPreprocessRent', async (done) => {
			await setupProviders()

			let rentOptions = {
				hashrate: 20000,
				duration: 5
			}

			let response = await autorenter.mrrRentPreprocess(rentOptions)
			expect(response.success).toBeTruthy()

			done()
		}, 250 * 100);
		it('manual preprocess rent | manualRentPreprocess', async (done) => {
			await setupProviders()

			let rentOptions = {
				hashrate: 10000,
				duration: 3
			}

			let preprocess = await autorenter.manualRentPreprocess(rentOptions)
			let statusCheck = false;
			switch (preprocess.status) {
				case 'NORMAL':
				case 'LOW_BALANCE':
				case 'ERROR':
					statusCheck = true
					break
				default:
					break
			}
			expect(statusCheck).toBeTruthy()

			done()
		}, 250 * 100);
		it('manual rent (new) | manualRent', async () => {
			await setupProviders()
			let rentOptions = {
				hashrate: 30000,
				duration: 3
			}

			let preprocess = await autorenter.manualRent(rentOptions)

		});
	})
	describe('Setup multile providers of different types', () => {
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
		it('load multi provider data from storage', async (done) => {
			let spartan = new SpartanBot({memory: false})
			await spartan._deserialize
			await spartan._wallet_create

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

			let mrr = await spartan.setupRentalProvider({
				type: "MiningRigRentals",
				api_key: apikey.api_key,
				api_secret: apikey.api_secret,
				name: "MRR"
			})

			let options = {
				algo: 'scrypt',
				host: 'ryan',
				port: 33,
				user: 'y',
				pass: 'x',
				name: 'lightsaber'
			}
			await spartan.createPool(options)

			let match = false;
			for (let pool of spartan.pools) {
				if (pool.name === options.name) {
					match = true
				}
			}
			expect(match).toBeTruthy()
			done()
		})
		it('create a global pool (2 providers)', async (done) => {
			let spartan = new SpartanBot({memory: true})

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

			let options = {
				algo: 'scrypt',
				host: 'host.test.this',
				port: 33,
				user: 'y',
				pass: 'x',
				name: 'thunderbird'
			}
			await spartan.createPool(options)

			for (let p of spartan.getRentalProviders()) {
				let match = false
				for (let pool of p.returnPools()) {
					if (pool.name === options.name) {
						match = true
					}
				}
				expect(match).toBeTruthy()
			}
			done()
		})
		it('create and then delete pool (2 providers)', async (done) => {
			let spartan = new SpartanBot({memory: true})

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

			let options = {
				algo: 'scrypt',
				host: 'test.test.this',
				port: 33,
				user: 'y',
				pass: 'x',
				name: uid()
			}
			await spartan.createPool(options)

			let id;
			let results = []
			let poolsFound = []
			for (let p of spartan.getRentalProviders()) {
				for (let pool of p.returnPools()) {
					if (pool.name === options.name) {
						id = pool.id
						results.push(true)
						poolsFound.push(pool)
					}
				}
			}
			expect(results.length).toEqual(2)
			let res = await spartan.deletePool(id)
			expect(res.success).toBeTruthy()

			done()
		});
		it('delete a pool that only one provider has', async () => {
			let spartan = new SpartanBot({memory: true})

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

			let options = {
				algo: 'scrypt',
				host: 'test.DELETE.test.DELETE.test.DELETE.',
				port: 33,
				user: 'y',
				pass: 'x',
				name: uid()
			}
			let poolsCreated = await spartan.createPool(options)
			let nh = spartan.getRentalProviders()[0]
			expect(nh.returnPools().length === 1)

			let mrrP = spartan.getRentalProviders()[1]
			let mrrPoolsLen = mrrP.returnPools().length

			let idToDelete = poolsCreated[0].id
			await spartan.deletePool(idToDelete)

			expect(nh.returnPools().length === 0)
			expect(mrrP.returnPools().length).toEqual(mrrPoolsLen - 1)
		})
		it('create, update, and delete a pool', async (done) => {
			let spartan = new SpartanBot({memory: true})

			let nh = await spartan.setupRentalProvider({
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

			let options = {
				algo: 'scrypt',
				host: 'AAAAAAAAAAAAAAAAAAAAAAAAAA',
				port: 333,
				user: 'AAAAAAAAAAAAAAAAAAAAAAAAAA',
				pass: 'AAAAAAAAAAAAAAAAAAAAAAAAAA',
				name: 'AAAAAAAAAAAAAAAAAAAAAAAAAA'
			}
			let poolsCreated = await spartan.createPool(options)
			let id = poolsCreated[0].mrrID || poolsCreated[0].id

			for (let provider of spartan.getRentalProviders()) {
				let checkFn = (id, name, provider) => {
					for (let pool of provider.returnPools()) {
						if (pool.id === id)
							expect(pool.name === name)
					}
				}
				checkFn(id, options.name, provider)
			}

			let newOptions = {
				algo: 'x11',
				host: 'BBBBBBBBBBBBBBBBBBBBBBBBBBB',
				port: 555,
				user: 'BBBBBBBBBBBBBBBBBBBBBBBBBBB',
				pass: 'BBBBBBBBBBBBBBBBBBBBBBBBBBB',
				name: 'BBBBBBBBBBBBBBBBBBBBBBBBBBB'
			}

			await spartan.updatePool(id, newOptions)

			for (let provider of spartan.getRentalProviders()) {
				let checkFn = (id, name, provider) => {
					for (let pool of provider.returnPools()) {
						if (pool.id === id)
							expect(pool.name === name)
					}
				}
				checkFn(id, newOptions.name, provider)
			}
			await spartan.deletePool(id)

			done()
		})
		describe('Pool Profiles', () => {
			it('get pool profiles', async () => {
				let spartan = new SpartanBot({memory: true})

				let mrr = await spartan.setupRentalProvider({
					type: "MiningRigRentals",
					api_key: apikey.api_key,
					api_secret: apikey.api_secret,
					name: "MRR"
				})

				let profs = await spartan.getPoolProfiles()
				expect(profs.length > 0).toBeTruthy()
			})
			it('create and delete a pool profile', async () => {
				let spartan = new SpartanBot({memory: true})

				let mrr = await spartan.setupRentalProvider({
					type: "MiningRigRentals",
					api_key: apikey.api_key,
					api_secret: apikey.api_secret,
					name: "MRR"
				})

				let name = 'Test Profile Name';
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

				let mrr = await spartan.setupRentalProvider({
					type: "MiningRigRentals",
					api_key: apikey.api_key,
					api_secret: apikey.api_secret,
					name: "MRR"
				})

				let p = spartan.returnPoolProfiles()
				expect(p.length > 0).toBeTruthy()
			})
		})
	})
})