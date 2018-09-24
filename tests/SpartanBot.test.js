import SpartanBot from '../src/SpartanBot'
import { config } from 'dotenv'
import AutoRenter from "../src/AutoRenter";
config()

const apikey = {
	api_key: process.env.API_KEY,
	api_secret: process.env.API_SECRET
};

const apikey2 = {
	api_key: process.env.API_KEY_2,
	api_secret: process.env.API_SECRET_2
}
// After all the tests have run, remove the test data :)
afterAll(() => {
	require('./rm-test-data.js')
})

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
	describe('AutoRenter with mulitple providers', () => {
		it('preprocess rent', async (done) => {
			let spartan = new SpartanBot({ memory: true })

			let setup1 = await spartan.setupRentalProvider({
				type: "MiningRigRentals",
				api_key: apikey.api_key,
				api_secret: apikey.api_secret,
				name: "Ryan"
			})

			let setup2 = await spartan.setupRentalProvider({
				type: "MiningRigRentals",
				api_key: apikey2.api_key,
				api_secret: apikey2.api_secret,
				name: "Erik"
			})

			let autorenter = new AutoRenter({
				rental_providers: spartan.rental_providers
			})

			// let m1 = spartan.rental_providers[0]
			// let m2 = spartan.rental_providers[1]
			//
			// console.log("m1: ", await m1.testAuthorization())
			// console.log("m2: ", await m2.testAuthorization())

			// console.log(autorenter)
			let rentOptions = {
				hashrate: 10000,
				duration: 5
			}

			let response = await autorenter.manualRentPreprocess(rentOptions)
			console.log(response)

			done()
		}, 250 * 100);
	})
})