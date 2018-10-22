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

	startup(self){
		self.scanner = new ChainScanner({
			log_level: "silent",
			peer_log_level: "silent",
			disableLogUpdate: true
		})

		self.emitter.on(CollectiveDefense, () => self.collectiveDefensive(self))
		self.checkNodeStatus(self)
	}

	checkNodeStatus(self){
		let syncStatus = self.scanner.getSyncStatus()
		console.log('sync status: ', syncStatus)
		if (syncStatus.synced && syncStatus.sync_percent > 0.99)
			self.emitter.emit(NODE_SYNCED, self.scanner)
		else
			setTimeout(() => self.checkNodeStatus(self), 20 * 1000)
	}
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