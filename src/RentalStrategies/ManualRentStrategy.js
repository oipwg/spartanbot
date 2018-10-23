import GenericStrategy from './GenericStrategy'
import {TriggerRental, ManualRent} from "../constants";

class ManualRentStrategy extends GenericStrategy {
	constructor(settings){
		super(settings);

		this.type = ManualRent
		this.startup()
	}

	static getType(){
		return ManualRent
	}

	startup(){
		this.emitter.on(ManualRent, (hashrate, duration, rentSelector) => {
			this.emitter.emit(TriggerRental, hashrate, duration, rentSelector)
		})
	}

	manualRent(hashrate, duration, rentSelector) {
		this.emitter.emit(ManualRent, hashrate, duration, rentSelector)
	}

}

export default ManualRentStrategy
