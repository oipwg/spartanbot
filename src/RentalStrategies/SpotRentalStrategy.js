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
	NODE_SYNCED, CHECK_SPOT_PROFIT, NORMAL, SpartanSense, WARNING, ERROR
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
		this.emitter.on(SpotRental, this.startup.bind(this))
	}

	spotRental(rentSelector, fullnode, spartan) {
		this.emitter.emit(SpotRental, rentSelector, fullnode, spartan)
	}

	startup(rentSelector, fullnode, spartan) {
		this.emitter.on('error', (type, error, message) => {
			console.error(`There was an error in the ${type} event: `, error, message);
		});

		let rental_providers = spartan.getRentalProviders()
		assert(rental_providers.length === 2, 'Must setup a MRR Provider and a NiceHash Provider')
		for (let prov of rental_providers) {
			if (prov.getInternalType() === "MiningRigRentals")
				this.mrr = prov
			if (prov.getInternalType() === "NiceHash")
				this.nh = prov
		}

		if (fullnode) {
			let SpartanSenseEE = spartan.getRentalStrategies(SpartanSense).emitter
			SpartanSenseEE.on(NODE_SYNCED, (scanner) => this.onNodeSynced(scanner))
			this.emitter.on(CHECK_SPOT_PROFIT, () => this.checkProfitability(rentSelector))
			SpartanSenseEE.emit(StartupChainScanner)
		} else {
			this.checkProfitability(rentSelector)
				.then(() => {})
				.catch(err => {console.error('error running check profitability', err)})
		}
	}

	onNodeSynced(scanner) {
		console.log(NODE_SYNCED)
		this.scanner = scanner
		this.emitter.emit(CHECK_SPOT_PROFIT)
	}

	async calculateSpotProfitability() {
		console.log('calculating spot profit')

		let weightedRentalCosts
		try {
			weightedRentalCosts = await getMarketStats(false, this.mrr.api, this.nh.api)
		} catch (err) {
			throw new Error(`Failed getting market stats: ${err}`)
		}

		let btcFLO
		try {
			let ret = (await axios.get("https://bittrex.com/api/v1.1/public/getticker?market=btc-flo")).data
			btcFLO = ret.result.Last
		} catch (err) {
			throw new Error(`Failed to get btcFLO price: ${err}`)
		}
		// let usdBTC = (await axios.get("https://bittrex.com/api/v1.1/public/getticker?market=usd-btc")).data
		// usdBTC = usdBTC.result.Last
		// let floPriceUSD = usdBTC * btcFLO

		const time = 3
		const PWTh1 = 0.3
		const FLOperBlock = 12.5
		const TargetBlockTime = 40

		let diff, currentPoolHashrate, target;
		let poolEndpoint = "https://mk1.alexandria.io/pool/api/pools"

		let poolData
		try {
			poolData = (await axios.get(poolEndpoint)).data
		} catch (err) {
			throw new Error(`Failed to get pool data from "https://mk1.alexandria.io/pool/api/pools": ${err}`)
		}
		if (poolData.pools[0]) {
			currentPoolHashrate = poolData.pools[0].poolStats.poolHashrate
			target = poolData.pools[0].networkStats.nextTarget
		} else {
			return {status: ERROR, success: false, message: `Failed to get current pool hashrate from ${poolEndpoint}`}
		}

		if (this.scanner) {
			diff = await this.scanner.getDifficulty()
		} else {
			const powLimitBN = new BN("0x00000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", 16, 'be')
			let targetHex = '0x'+target
			let targetBN = new BN(targetHex, 16, 'be')
			let div = powLimitBN.div(targetBN)
			diff = div/(1024 * 4)
		}
		let NextDiff = diff
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

		//hashes per second
		let CurrentPoolHashrate = currentPoolHashrate || 0 //ToDo: get this value when there's a livenet pool ready pool.oip.fun/api/pools
		let hashrateToRent = (((NextDiff * Math.pow(2, 32)) / (TargetBlockTime / PWTh1)) - CurrentPoolHashrate)
		let hashrateToRentMH = Math.round(hashrateToRent/1e6)

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
	async checkProfitability(rentSelector) {
		let spotProfit = {}
		try {
			spotProfit = await this.calculateSpotProfitability()
		} catch (err) {
			this.emitter.emit(error, CHECK_SPOT_PROFIT, err, 'in function: calculateSpotProfitability')
		}
		const idealProfitMargin = 10
		if (spotProfit.margin >= idealProfitMargin) {
			console.log('Profit margin is equal to or above 10%: trigger rental')
			this.emitter.emit(TriggerRental, spotProfit.hashrateToRentMH, 3, rentSelector)
		} else {
			setTimeout(() => this.checkProfitability(), 1000 * 40)
		}
	}

}

export default SpotRentalStrategy
