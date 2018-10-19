import uid from 'uid'

class GenericStrategy {
	constructor(settings){
		this.type = "Generic"

		this.uid = settings.uid || uid()
		this.emitter = settings.emitter
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

	getEmitter() {
		return this.emitter
	}

	serialize(){
		return {
			type: this.type,
			uid: this.uid
		}
	}
}

export default GenericStrategy