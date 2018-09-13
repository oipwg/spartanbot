import SpartanBot from '../src/SpartanBot'

// After all the tests have run, remove the test data :)
afterAll(() => {
	require('./rm-test-data.js')
})

describe("SpartanBot", () => {
	describe("Settings", () => {
		it("Should be able to set a setting", () => {
			let spartan = new SpartanBot()

			spartan.setSetting("test-setting", "test-setting-data")
			expect(spartan.settings['test-setting']).toBe("test-setting-data")
		})
		it("Should be able to get a setting", () => {
			let spartan = new SpartanBot()

			spartan.setSetting("test-setting2", "test-setting-data2")
			expect(spartan.getSetting('test-setting2')).toBe("test-setting-data2")
		})
	})

	describe("Manual Rental", () => {
		it("Should be able to rent manually (no confirmation function)", async () => {
			let spartan = new SpartanBot()

			let rental = await spartan.manualRental(1000, 86400)

			expect(rental.success).toBe(true)
		})
		it("Should be able to use confirmation function", async () => {
			let spartan = new SpartanBot()

			let rental = await spartan.manualRental(1000, 86400, async (info) => {
				return true
			})

			expect(rental.success).toBe(true)
		})
		it("Should be able to cancel", async () => {
			let spartan = new SpartanBot()

			let rental = await spartan.manualRental(1000, 86400, async (info) => {
				return false
			})

			expect(rental.success).toBe(false)
			expect(rental.info).toBe("Manual Rental Cancelled")
		})
	})

	describe("Save and Reload", () => {
		it("Should be able to Serialize & Deserialize", () => {
			let spartan = new SpartanBot({ test: "setting" })

			spartan.serialize()

			let spartan2 = new SpartanBot()

			expect(spartan2.getSetting('test')).toBe("setting")
		})
	})
})