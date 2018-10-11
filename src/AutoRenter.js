import Exchange from 'oip-exchange-rate';

const NiceHash = "NiceHash"
const MiningRigRentals = "MiningRigRentals"

import {toNiceHashPrice} from "./util";

const ERROR = 'ERROR'
const NORMAL = 'NORMAL'
const LOW_BALANCE = 'LOW_BALANCE'

/**
 * Manages Rentals of Miners from multiple API's
 */
class AutoRenter {
	/**
	 * [constructor description]
	 * @param  {Object} settings - The Options for the AutoRenter
	 * @param  {Array.<RentalProvider>} settings.rental_providers - The Rental Providers that you wish to use to rent miners.
	 * @return {Boolean}
	 */
	constructor(settings){
		this.settings = settings
		this.rental_providers = settings.rental_providers
		this.exchange = new Exchange();
	}

	/**
	 * Preprocess Rent for MiningRigRental Providers
	 * @param {Object} options - The Options for the rental operation
	 * @param {Number} options.hashrate - The amount of Hashrate you wish to rent
	 * @param {Number} options.duration - The duration (in seconds) that you wish to rent hashrate for
	 * @returns {Promise<Object|Array.<Object>>}
	 */
	async mrrRentPreprocess(options) {
		//ToDo: make sure providers profileIDs aren't the same

		let status = {status: NORMAL}

		//get available rigs based on hashpower and duration
		let _provider;
		let mrr_providers = []
		for (let provider of this.rental_providers) {
			if (provider.getInternalType() === "MiningRigRentals") {
				_provider = provider
				mrr_providers.push(provider)
			}
		}
		if (!_provider)
			return {success: false, message: 'No MRR Providers'}

		let rigs_to_rent = [];
		try {
			rigs_to_rent = await _provider.getRigsToRent(options.hashrate, options.duration)
		} catch (err) {
			status.status = ERROR
			return {status, market: MiningRigRentals, message: 'failed to fetch rigs', err}
		}

		//divvy up providers and create Provider object
		let providers = [], totalBalance = 0;
		for (let provider of mrr_providers) {
			//get the balance of each provider
			let balance = await provider.getBalance();
			totalBalance += balance
			//get the profile id needed to rent for each provider
			let profile = provider.returnActivePoolProfile() || await provider.getProfileID();
			providers.push({
				balance,
				profile,
				rigs_to_rent: [],
				uid: provider.getUID(),
				provider
			})
		}

		let hashrate_found = _provider.getTotalHashPower(rigs_to_rent)
		let cost_found = _provider.getRentalCost(rigs_to_rent)

		// console.log("total hashpower: ", hashpower_found)
		// console.log("total cost: ", cost_found)

		// ToDo: Consider not splitting the work up evenly and fill each to his balance first come first serve
		//load up work equally between providers. 1 and 1 and 1 and 1, etc
		let iterator = 0; //iterator is the index of the provider while, 'i' is the index of the rigs
		let len = providers.length
		for (let i = 0; i < rigs_to_rent.length; i++) {
			if (i === len || iterator === len) {
				iterator = 0
			}
			providers[iterator].rigs_to_rent.push(rigs_to_rent[i])
			iterator += 1
		}

		//remove from each provider rigs (s)he cannot afford
		let extra_rigs = []
		for (let p of providers) {
			let rental_cost = _provider.getRentalCost(p.rigs_to_rent);

			if (p.balance < rental_cost) {
				while (p.balance < rental_cost && p.rigs_to_rent.length > 0) {
					// console.log(`balance: ${p.balance}\nRental cost: ${rental_cost}\nOver Under: ${p.balance-rental_cost}\nAmount substracted -${p.rigs_to_rent[0].btc_price}\nLeft Over: ${rental_cost-p.rigs_to_rent[0].btc_price}`)
					let tmpRig;
					[tmpRig] = p.rigs_to_rent.splice(0,1)
					extra_rigs.push(tmpRig)

					rental_cost = _provider.getRentalCost(p.rigs_to_rent)
				}
			}
		}

		//add up any additional rigs that a provider may have room for
		for (let p of providers) {
			let rental_cost = _provider.getRentalCost(p.rigs_to_rent);
			if (p.balance > rental_cost) {
				for (let i = extra_rigs.length -1; i >= 0; i--){
					if ((extra_rigs[i].btc_price + rental_cost) <= p.balance) {
						let tmpRig;
						[tmpRig] = extra_rigs.splice(i,1);
						p.rigs_to_rent.push(tmpRig)
						rental_cost = _provider.getRentalCost(p.rigs_to_rent);
					}
				}
			}
		}

		let providerBadges = []
		for (let p of providers) {
			status.status = NORMAL

			p.provider.setActivePoolProfile(p.profile)
			for (let rig of p.rigs_to_rent) {
				rig.rental_info.profile = p.profile
			}

			let price = 0, limit = 0, amount = 0, duration = options.duration;
			amount += p.provider.getRentalCost(p.rigs_to_rent)
			limit += (p.provider.getTotalHashPower(p.rigs_to_rent) / 1000 / 1000)
			price = toNiceHashPrice(amount, limit, duration)
			let market = MiningRigRentals
			let balance = p.balance

			if (cost_found > balance) {
				status.status = LOW_BALANCE
			} else if (p.rigs_to_rent.length === 0) {
				status.status = ERROR
			}

			providerBadges.push({
				balance,
				limit,
				price,
				amount,
				duration,
				status,
				market,
				query: {
					hashrate_found,
					cost_found
				},
				rigs: p.rigs_to_rent,
				uid: p.uid,
				provider: p.provider,
				success: true
			})
		}
		if (providerBadges.length === 1) {
			return providerBadges[0]
		} else {
			return providerBadges
		}
	}

	/**
	 * Rent an amount of hashrate for a period of time
	 * @param {Object} options - The Options for the rental operation
	 * @param {Number} options.hashrate - The amount of Hashrate you wish to rent
	 * @param {Number} options.duration - The duration (IN SECONDS) that you wish to rent hashrate for
	 * @return {Promise<Object>} Returns a Promise that will resolve to an Object containing info about the rental made
	 */
	async manualRentPreprocess(options) {
		let mrrProviders = []
		let nhProviders = []

		for (let provider of this.rental_providers) {
			if (provider.getInternalType() === NiceHash) {
				nhProviders.push(provider)
			}
			if (provider.getInternalType() === MiningRigRentals) {
				mrrProviders.push(provider)
			}
		}

		let badges = []

		if (mrrProviders.length >= 1) {
			let mrrPreprocess = await this.mrrRentPreprocess(options)
			if (Array.isArray(mrrPreprocess)) {
				for (let badge of mrrPreprocess) {
					badges.push(badge)
				}
			} else {badges.push(mrrPreprocess)}
		}

		for (let prov of nhProviders) {
			badges.push(await prov.manualRentPreprocess(options.hashrate, options.duration))
		}

		let normal_badges = []
		let low_balance_badges = []
		let error_badges = []

		for (let badge of badges) {
			switch (badge.status.status) {
				case NORMAL:
					normal_badges.push(badge)
					break
				case LOW_BALANCE:
					low_balance_badges.push(badge)
					break
				case ERROR:
					error_badges.push(badge)
					break
			}
		}

		//check for successful preprocess
		if (normal_badges.length === 1) {
			return {status: NORMAL, badges: normal_badges[0]}
		} else if (normal_badges.length > 1) {
			let amount = 10000; //begin with an arbitrarily large number
			let best_badge;
			for (let badge of normal_badges) {
				if (Number(badge.amount) < amount) {
					amount = Number(badge.amount)
					best_badge = badge
				}
			}
			return {status: NORMAL, badges: best_badge}
		}

		//check for low balance preprocess
		if (low_balance_badges.length > 0 ) {
			let teraHash = options.hashrate/1000/1000
			let totalTeraHash = 0;
			for (let badge of low_balance_badges) {
				totalTeraHash += badge.limit
			}
			if (totalTeraHash <= teraHash) {
				return {status: LOW_BALANCE, badges: low_balance_badges}
			} else {
				let badges = []
				totalTeraHash = 0;
				low_balance_badges.sort((a,b) => {return a.amount - b.amount})
				for (let badge of low_balance_badges) {
					if ((totalTeraHash + Number(badge.limit)) <= teraHash) {
						totalTeraHash += Number(badge.limit)
						badges.push(badge)
					}
				}
				return {status: LOW_BALANCE, badges}
			}
		}

		if (error_badges > 0) {
			return {status: ERROR, badges: error_badges}
		}
	}

	/**
	 * Confirms the preprocess returned information (this function merely organizes the preprocess data FOR the confirmFn)
	 * @param {Object} preprocess - the returned object from manualRentPreprocess()
	 * @param {Function} confirmFn - an async function to confirm the preprocess
	 * @returns {Promise<Boolean>}
	 */
	async confirmPreprocess(preprocess, confirmFn) {
		let badges = preprocess.badges
		let limit = 0, amount = 0, price = 0, balance = 0, duration

		let market = []
		if (Array.isArray(badges)) {
			for (let badge of badges) {
				limit += Number(badge.limit)
				amount += Number(badge.amount)
				price += Number(badge.price)
				balance += Number(badge.balance)
				duration = badge.duration

			let nh = market.includes(NiceHash)
			let mrr = market.includes(MiningRigRentals)
			if (nh && mrr) {
				market = 'MIXED'
			} else if (nh) {
				market = NiceHash
			} else {
				if (mrr)
					market = MiningRigRentals
			}

		} else {
			limit += Number(badges.limit)
			amount += Number(badges.amount)
			price += Number(badges.price)
			balance += Number(badges.balance)
			duration = badges.duration
			market = badges.market
		}

		return await confirmFn({
			limit,
			amount,
			price,
			duration,
			balance,
			market,
			status: preprocess.status
		})
	}

	/**
	 * Manual rent based an amount of hashrate for a period of time
	 * @param {Object} options - The Options for the rental operation
	 * @param {Number} options.hashrate - The amount of Hashrate you wish to rent
	 * @param {Number} options.duration - The duration (IN HOURS) that you wish to rent hashrate for
	 * @param {Function} [options.confirm] - This function will be run to decide if the rental should proceed. If it returns `true`, the rental will continue, if false, the rental cancels
	 * @return {Promise<Object>} Returns a Promise that will resolve to an Object containing info about the rental made
	 */
	async manualRent(options) {
		if (!(this.rental_providers.length >= 1)){
			return {
				success: false,
				type: "NO_RENTAL_PROVIDERS",
				message: "Rent Cancelled, no RentalProviders found to rent from"
			}
		}

		//preprocess
		let preprocess;
		try {
			preprocess = await this.manualRentPreprocess(options)
		} catch (err) {
			throw new Error(`Failed to get prepurchase_info! \n ${err}`)
		}

		if (preprocess.status === ERROR) {
			return {success: false, message: 'No providers are capable of renting with set options', preprocess}
		}

		if (options.confirm) {
			let proceed = await this.confirmPreprocess(preprocess, options.confirm)
			if (!proceed)
				return {success: false, message: `Rental Cancelled`}
		}


	}

	//this is now to use just as reference until later date
	/**
	 * Rent an amount of hashrate for a period of time
	 * @param {Object} options - The Options for the rental operation
	 * @param {Number} options.hashrate - The amount of Hashrate you wish to rent
	 * @param {Number} options.duration - The duration (IN SECONDS) that you wish to rent hashrate for
	 * @param {Function} [options.confirm] - This function will be run to decide if the rental should proceed. If it returns `true`, the rental will continue, if false, the rental cancels
	 * @return {Promise<Object>} Returns a Promise that will resolve to an Object containing info about the rental made
	 */
	async rent(options) {
		// Make sure we have some Rental Providers, if not, return failure
		if (!(this.rental_providers.length >= 1)){
			return {
				success: false,
				type: "NO_RENTAL_PROVIDERS",
				message: "Rent Cancelled, no RentalProviders found to rent from"
			}
		}

		// tmp convert for MRRProvider
		let hours = options.duration / 60 / 60
		options.duration = hours

		//preprocess
		let prepurchase_info;
		try {
			prepurchase_info = await this.mrrRentPreprocess(options)
		} catch (err) {
			throw new Error(`Failed to get prepurchase_info! \n ${err}`)
		}

		let status = {
			status: 'normal'
		}

		if (prepurchase_info.total_balance < prepurchase_info.initial_cost) {
			status.status = 'warning';
			status.type = 'LOW_BALANCE_WARNING'
			status.totalBalance = prepurchase_info.btc_total_price

			if (prepurchase_info.initial_rigs === 0) {
				status.message = `Could not find any rigs to rent with available balance`
			} else {
				status.message = `${prepurchase_info.total_rigs}/${prepurchase_info.initial_rigs} rigs available to rent with current balance.`
			}
		}

		// -> confirm total
		if (options.confirm){
			try {
				let btc_to_usd_rate = await this.exchange.getExchangeRate("bitcoin", "usd")

				let should_continue = await options.confirm({
					total_cost: (prepurchase_info.initial_cost * btc_to_usd_rate).toFixed(2),
					cost_to_rent: (prepurchase_info.btc_total_price * btc_to_usd_rate).toFixed(2),
					hashrate_to_rent: prepurchase_info.total_hashrate,
					total_rigs: prepurchase_info.total_rigs,
					status
				})

				if (!should_continue) {
					return {success: false, message: `Rental Cancelled`}
				}
			} catch (e) {
				return {success: false, message: `Rental Cancelled: \n ${e}`}
			}
		}

		//rent
		let rental_info
		try {
			rental_info = await this.rental_providers[0].rent(prepurchase_info.rigs)
		} catch (err) {
			throw new Error(`Error renting rigs in AutoRenter: \n ${err}`)
		}

		//check rental success
		if (!rental_info.success)
			return rental_info

		let btc_to_usd_rate = await this.exchange.getExchangeRate("bitcoin", "usd")
		let total_rigs = 0

		if (rental_info.rented_rigs)
			total_rigs = rental_info.rented_rigs.length

		return {
			success: true,
			total_rigs_rented: total_rigs,
			total_cost: (rental_info.btc_total_price * btc_to_usd_rate).toFixed(2),
			total_hashrate: rental_info.total_hashrate
		}
	}

}

export default AutoRenter