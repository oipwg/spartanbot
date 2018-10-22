import GenericStrategy from './GenericStrategy'
import getMarketStats from 'market-rental-stats'
import axios from 'axios'
import {config} from 'dotenv'

config()

import {
	error,
	TriggerRental,
	SpotRent,
	CollectiveDefense,
	StartupSpotRentalStrategy,
	StartupChainScanner,
	NODE_SYNCED, CHECK_SPOT_PROFIT
} from "../constants";

class SpotRentStrategy extends GenericStrategy {
	constructor(settings) {
		super(settings);

		this.type = SpotRent

		this.setup()
	}

	static getType() {
		return SpotRent
	}

	setup() {
		this.emitter.on(StartupSpotRentalStrategy, () => this.startup(this))
	}

	startup(self) {
		self.emitter.on(NODE_SYNCED, (scanner) => self.onNodeSynced(self, scanner))
		self.emitter.on(CHECK_SPOT_PROFIT, () => self.checkProfitability(self))
		self.emitter.emit(StartupChainScanner)
	}

	onNodeSynced(self, scanner) {
		console.log(NODE_SYNCED)
		self.scanner = scanner
		self.emitter.emit(CHECK_SPOT_PROFIT)
	}

	async calculateSpotProfitability(self) {
		//ToDo: Standardize env var names
		if (!process.env.API_KEY || !process.env.API_SECRET || !process.env.NICEHASH_API_KEY || !process.env.NICEHASH_API_ID)
			throw new Error('Must provide MRR and NiceHash API_KEYS')
		let mrrAPIkeys = {
			key: process.env.API_KEY,
			secret: process.env.API_SECRET
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
		let hashrateToRent = ((NextDiff * Math.pow(2, 32)) / (TargetBlockTime / PWTh1)) - CurrentPoolHashrate

		return {
			isProfitable: profitBTC > 0,
			costBTC,
			costFLO,
			revenueBTC,
			revenueFLO,
			profitBTC,
			profitFLO,
			margin,
			hashrateToRent
		}
	}
	async checkProfitability(self) {
		console.log('check profit')
		let spotProfit = {}
		try {
			spotProfit = await self.calculateSpotProfitability()
		} catch (err) {
			this.emitter.emit('error', err)
		}
		if (spotProfit.isProfitable) {
			console.log('trigger rental')
			// this.emitter.emit(TriggerRental, hashrate, duration, rentSelector)
		} else {
			setTimeout(this.checkProfitability(), 1000 * 40)
		}
	}

}

export default ManualRentStrategy
