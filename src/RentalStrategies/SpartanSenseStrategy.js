import GenericStrategy from './GenericStrategy'
import { ChainScanner } from 'spartansense'
import {CHECK_NODE_STATUS, CollectiveDefense, NODE_SYNCED, STARTUP, StartupChainScanner} from "../constants";

class SpartanSenseStrategy extends GenericStrategy {
	constructor(settings){
		super(settings);

		this.type = "SpartanSense"

		this.setup()
	}

	static getType(){
		return "SpartanSense"
	}

	setup(){
		this.emitter.on(StartupChainScanner, () => this.startup(this))
	}

			log_level: "silent",
			peer_log_level: "silent",
			disableLogUpdate: true
		})

		this.scanner.onReorgTrigger((reorg_info) => {
			// Using this reorg_info, you can decide if you should emit a "TriggerRental" event.
			//{ best_height_tip: this.best_active_tip, reorg_tip: tip }
			console.log(reorg_info)

			// If you emit "TriggerRental" then the "manualRental" function of SpartanBot will be run using the paramaters passed
			/*
			this.emitter.emit("TriggerRental", hashrate, duration, rentSelector)
			 */
		})
	}
}

export default SpartanSenseStrategy