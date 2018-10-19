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
		this.emitter.on(ManualRent, (hashrate, duration, rentSelector, self) => {
			this.emitter.emit(TriggerRental, hashrate, duration, rentSelector, self)
		})
	}
}

export default ManualRentStrategy