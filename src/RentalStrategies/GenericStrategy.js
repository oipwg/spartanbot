import uid from 'uid'
import EventEmitter from 'eventemitter3'

class GenericStrategy {
	constructor(settings){
		this.type = "Generic"

		this.uid = settings.uid || uid()
		this.emitter = new EventEmitter()
	}

	onRentalTrigger(rentalFunction){
		this.emitter.on("TriggerRental", rentalFunction)
	}

	setUID(id) {
		this.uid = id
	}

	getUID(){
		return this.uid
	}

	getInternalType() {
		return this.type
	}

	static getType(){
		return "Generic"
	}

	serialize(){
		return {
			type: this.type,
			uid: this.uid
		}
	}
}

export default GenericStrategy