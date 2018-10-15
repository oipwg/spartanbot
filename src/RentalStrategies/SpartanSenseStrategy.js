import GenericStrategy from './GenericStrategy'
import { ChainScanner } from 'SpartanSense'

class SpartanSenseStrategy extends GenericStrategy {
	constructor(settings){
		super(settings);

		this.type = "SpartanSense"

		this.startup()
	}

	static getType(){
		return "SpartanSense"
	}

	startup(){
		this.scanner = new ChainScanner({
			log_level: "silent",
			peer_log_level: "silent",
			disableLogUpdate: true
		})

		this.scanner.onReorgTrigger((reorg_info) => {
			// Using this reorg_info, you can decide if you should emit a "TriggerRental" event.
			console.log(reorg_info)

			// If you emit "TriggerRental" then the "manualRental" function of SpartanBot will be run using the paramaters passed
			/*
			this.emitter.emit("TriggerRental", hashrate, duration, rentSelector)
			 */
		})
	}
}

export default SpartanSenseStrategy