import GenericStrategy from './GenericStrategy'
import getMarketStats from 'market-rental-stats'
import axios from 'axios'
import {config} from 'dotenv'

config()

import {
	error,
	TriggerRental,
	SpotRental,
	StartupSpotRentalStrategy,
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
		this.emitter.on(SpotRental, (spartan) => this.startup(spartan))
	}

	spotRental(spartan) {
		this.emitter.emit(SpotRental, spartan)
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

		let NextDiff = await self.scanner.getDifficulty()
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

	async checkProfitability(self) {
		// console.log('checkProfitability')
		let spotProfit = {}
		try {
			spotProfit = await self.calculateSpotProfitability(self)
			// console.log('profitability: ', spotProfit)
		} catch (err) {
			this.emitter.emit(error, CHECK_SPOT_PROFIT, err)
		}
		if (spotProfit.margin >= 10) {
			console.log('Profit margin is equal to or above 10%: trigger rental')
			// this.emitter.emit(TriggerRental, hashrate, duration, rentSelector)
		} else {
			// console.log("Not yet profitable... continue scanning")
			setTimeout(() => self.checkProfitability(self), 1000 * 40)
		}
	}

}

export default SpotRentalStrategy
