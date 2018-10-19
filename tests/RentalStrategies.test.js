import SpotRentalStrategy from '../src/RentalStrategies/SpotRentalStrategy'
import EventEmitter from 'eventemitter3'

describe('Rental Strategies', () => {
	describe('Spot Rental Strategy', () => {
		it('calculate spot profit', async () => {
			let ee = new EventEmitter()
			let rs = new SpotRentalStrategy({emitter: ee})
			rs.emitter.emit('SpotRent', rs)


		})
	})
})
