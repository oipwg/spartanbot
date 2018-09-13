import SpartanBot from '../src/SpartanBot'

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
	})

	describe("RentalProviders", () => {
		it("Should be able to setup new MRR RentalProvider", async () => {
			let spartan = new SpartanBot({ memory: true })

			let setup = await spartan.setupRentalProvider({
				type: "MiningRigRentals",
				api_key: "test-api-key",
				api_secret: "test-api-secret"
			})

			expect(setup.type).toBe("MiningRigRentals")
		})
		it("Should be able to get all rental providers", async () => {
			let spartan = new SpartanBot({ memory: true })

			await spartan.setupRentalProvider({
				type: "MiningRigRentals",
				api_key: "test-api-key",
				api_secret: "test-api-secret"
			})

			await spartan.setupRentalProvider({
				type: "MiningRigRentals",
				api_key: "test-api-key2",
				api_secret: "test-api-secret2"
			})

			let providers = spartan.getRentalProviders()

			expect(providers.length).toBe(2)
		})
		it("Should be able to delete a rental provider", async () => {
			let spartan = new SpartanBot({ memory: true })

			await spartan.setupRentalProvider({
				type: "MiningRigRentals",
				api_key: "test-api-key",
				api_secret: "test-api-secret"
			})

			await spartan.setupRentalProvider({
				type: "MiningRigRentals",
				api_key: "test-api-key2",
				api_secret: "test-api-secret2"
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
		it("Should be able to cancel", async () => {
			let spartan = new SpartanBot({ memory: true })

			let rental = await spartan.manualRental(1000, 86400, async (info) => {
				return false
			})

			expect(rental.success).toBe(false)
			expect(rental.info).toBe("Manual Rental Cancelled")
		})
	})

	describe("Save and Reload", () => {
		it("Should be able to Serialize & Deserialize", async () => {
			let spartan = new SpartanBot({ test: "setting" })

			let setup = await spartan.setupRentalProvider({
				type: "MiningRigRentals",
				api_key: "test-api-key",
				api_secret: "test-api-secret"
			})

			spartan.serialize()

			let spartan2 = new SpartanBot()

			// Wait for deserialization to finish
			await spartan2._deserialize

			expect(spartan2.getSetting('test')).toBe("setting")
		})
	})
})