import GenericStrategy from './GenericStrategy'
import getMarketStats from 'market-rental-stats'
import axios from 'axios'
import BN from 'bn.js'
import assert from 'assert'
import {config} from 'dotenv'
config()

import {
	error,
	TriggerRental,
	SpotRental,
	StartupChainScanner,
	NODE_SYNCED, CHECK_SPOT_PROFIT, NORMAL, SpartanSense
} from "../constants";

class SpotRentalStrategy extends GenericStrategy {
	constructor(settings) {
		super(settings);

		this.type = SpotRental
		this.setup()
	}

	static getType() {
		return SpotRental
	}

	setup() {
		this.emitter.on(SpotRental, (fullnode, spartan) => this.startup(fullnode, spartan))
	}

	spotRental(fullnode, spartan) {
		this.emitter.emit(SpotRental, fullnode, spartan)
	}

	startup(spartan) {
		let SpartanSenseEE = spartan.getRentalStrategies(SpartanSense).emitter
		SpartanSenseEE.on(NODE_SYNCED, (scanner) => this.onNodeSynced(scanner))
		this.emitter.on(CHECK_SPOT_PROFIT, () => this.checkProfitability())
		SpartanSenseEE.emit(StartupChainScanner)
	}

	onNodeSynced(scanner) {
		console.log(NODE_SYNCED)
		this.scanner = scanner
		this.emitter.emit(CHECK_SPOT_PROFIT)
	}

	async calculateSpotProfitability() {
		if (!process.env.MRR_API_KEY || !process.env.MRR_API_SECRET || !process.env.NICEHASH_API_KEY || !process.env.NICEHASH_API_ID)
			throw new Error('Must set MRR and NiceHash API_KEYS to env')
		let mrrAPIkeys = {
			key: process.env.MRR_API_KEY,
			secret: process.env.MRR_API_SECRET
		}

		let nhAPIkeys = {
			key: process.env.NICEHASH_API_KEY,
			id: process.env.NICEHASH_API_ID
		}

		let weightedRentalCosts = await getMarketStats(mrrAPIkeys, nhAPIkeys)
		// let usdBTC = (await axios.get("https://bittrex.com/api/v1.1/public/getticker?market=usd-btc")).data
		let btcFLO = (await axios.get("https://bittrex.com/api/v1.1/public/getticker?market=btc-flo")).data
		// usdBTC = usdBTC.result.Last
		btcFLO = btcFLO.result.Last
		// let floPriceUSD = usdBTC * btcFLO

		const time = 3
		const PWTh1 = 0.3
		const FLOperBlock = 12.5
		const TargetBlockTime = 40

		let NextDiff = await this.scanner.getDifficulty()
		let NetHashrate = (NextDiff * Math.pow(2, 32)) / TargetBlockTime
		let WeightedAverageRentalCostBtcThHour = parseFloat(weightedRentalCosts.weighted.toFixed(9)) // currently in BTC/GH/Hour
		let FLOPrice = btcFLO

		// console.log(time, FLOPrice, NextDiff, TargetBlockTime, FLOperBlock, PWTh1, WeightedAverageRentalCostBtcThHour, NetHashrate)

		//convert net hash rate to terahashes
		let costBTC = (NetHashrate / 1e12) * (WeightedAverageRentalCostBtcThHour) * time * PWTh1
		let costFLO = costBTC / btcFLO
		let revenueBTC = FLOperBlock * ((60 * 60) / TargetBlockTime) * time * FLOPrice * PWTh1
		let revenueFLO = revenueBTC / btcFLO

		let profitBTC = revenueBTC - costBTC
		let profitFLO = profitBTC / btcFLO
		let margin = Math.round((profitBTC / revenueBTC) * 10000) / 100

		let CurrentPoolHashrate = 0 //ToDo: get this value when there's a livenet pool ready pool.oip.fun/api/pools
		let hashrateToRentMH = Math.round((((NextDiff * Math.pow(2, 32)) / (TargetBlockTime / PWTh1)) - CurrentPoolHashrate)/1e6)

		return {
			isProfitable: profitBTC > 0,
			costBTC,
			costFLO,
			revenueBTC,
			revenueFLO,
			profitBTC,
			profitFLO,
			margin,
			hashrateToRentMH,
		}
	}

	async checkProfitability() {
		let spotProfit = {}
		try {
			spotProfit = await this.calculateSpotProfitability()
		} catch (err) {
			this.emitter.emit(error, CHECK_SPOT_PROFIT, err)
		}
		if (spotProfit.margin >= 10) {
			console.log('Profit margin is equal to or above 10%: trigger rental')
			this.emitter.emit(TriggerRental, 500, 3, async (p, o) => {
				let badges = p.badges;
				let _badge
				for (let b of badges) {
					if (b.status.status === NORMAL) {
						_badge = b
						break;
					}
				}
				// console.log("badger: ", _badge)
				return {confirm: false, badges: _badge}
			})
		} else {
			setTimeout(() => this.checkProfitability(), 1000 * 40)
		}
	}

}

export default SpotRentalStrategy
