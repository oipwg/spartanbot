import GenericStrategy from './GenericStrategy'
import {ChainScanner} from 'spartansense'
import {CollectiveDefense, NODE_SYNCED, StartupChainScanner, SpartanSense} from "../constants";

class SpartanSenseStrategy extends GenericStrategy {
	constructor(settings) {
		super(settings);

		this.type = SpartanSense
		this.setup()
	}

	static getType() {
		return SpartanSense
	}

	setup() {
		this.emitter.on(StartupChainScanner, this.startup.bind(this))
	}

	startup() {
		// console.log('Startup Chain Scanner')
		this.scanner = new ChainScanner({
			log_level: "silent",
			peer_log_level: "silent",
			disableLogUpdate: true
		})

		this.emitter.on(CollectiveDefense, () => this.collectiveDefensive())
		this.checkNodeStatus()
	}

	checkNodeStatus() {
		// console.log('Checking Node Status')
		let syncStatus = this.scanner.getSyncStatus()
		// console.log(syncStatus)
		if (syncStatus.synced && syncStatus.sync_percent > 0.99)
			this.emitter.emit(NODE_SYNCED, this.scanner)
		else
			setTimeout(() => this.checkNodeStatus(this), 10 * 1000)
	}

	collectiveDefensive() {
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
