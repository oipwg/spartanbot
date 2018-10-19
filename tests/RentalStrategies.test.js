import SpotRentalStrategy from '../src/RentalStrategies/SpotRentalStrategy'

describe('Rental Strategies', () => {
	describe('Spot Rental Strategy', () => {
		it('calculate spot profit', async () => {
			let rs = new SpotRentalStrategy({})
			let x = await rs.calculateSpotProfitability()


		})
	})
})