import Exchange from 'oip-exchange-rate';

const NiceHash = "NiceHash"
const MiningRigRentals = "MiningRigRentals"

import {toNiceHashPrice} from "./util";

const ERROR = 'ERROR'
const NORMAL = 'NORMAL'
const WARNING = 'WARNING'
const LOW_BALANCE = 'LOW_BALANCE'
const LOW_HASHRATE = 'LOW_HASHRATE'
const CUTOFF = 'CUTOFF'

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

		let hashratePerc = options.hashrate * .10
		let hashrateMin = options.hashrate - hashratePerc

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
			let status = {status: NORMAL}

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
				status.status = WARNING
				status.type = LOW_BALANCE
				if (hashrate_found < hashrateMin) {
					status.warning = LOW_HASHRATE
					status.message = `Can only find ${((hashrate_found/options.hashrate)*100).toFixed(2)}% of the hashrate desired`
				}
			} else if (p.rigs_to_rent.length === 0) {
				status.status = ERROR
				status.type = "NO_RIGS_FOUND"
			}

			providerBadges.push({
				market,
				status,
				amount,
				totalHashes: limit*60*60*duration,
				hashesDesired: (options.hashrate/1000/1000)*60*60*options.duration,
				duration,
				limit,
				price,
				balance,
				query: {
					hashrate_found,
					cost_found,
					duration: options.duration
				},
				uid: p.uid,
				rigs: p.rigs_to_rent,
				provider: p.provider
			})
		}
		if (providerBadges.length === 1) {
			return {success: true, badges: providerBadges[0]}
		} else {
			return {success: true, badges: providerBadges}
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
			if (!mrrPreprocess.success) {
				return mrrPreprocess
			} else {
				if (Array.isArray(mrrPreprocess.badges)) {
					for (let badge of mrrPreprocess.badges) {
						badges.push(badge)
					}
				} else {badges.push(mrrPreprocess.badges)}
			}

		}

		for (let prov of nhProviders) {
			badges.push(await prov.manualRentPreprocess(options.hashrate, options.duration))
		}
		// console.log("badge results: ", badges)

		let usable_badges = []
		let error_badges = []

		for (let badge of badges) {
			switch (badge.status.status) {
				case NORMAL:
					usable_badges.push(badge)
					break
				case WARNING:
					usable_badges.push(badge)
					break
				case ERROR:
					error_badges.push(badge)
					break
			}
		}

		if (usable_badges.length === 0 && error_badges > 0) {
			return {status: ERROR, badges: error_badges}
		} else
			return {status: NORMAL, badges: usable_badges}
	}

	/**
	 * Selects the best rental options from the returned preprocess function
	 * @param {Object} preprocess - the returned object from manualRentPreprocess()
	 * @param {Object} options - options passed down into manualRent func (hashrate, duration)
	 * @returns {Promise<{Object}>}
	 */
	async manualRentSelector(preprocess, options) {
		let badges = preprocess.badges
		const totalHashesDesired = (options.hashrate/1000/1000)*60*60*options.duration

		let normal_badges = []
		let warning_badges = []
		for (let badge of badges) {
			if (badge.status.status === NORMAL) {
				normal_badges.push(badge)
			} else if (badge.status.status === WARNING) {
				warning_badges.push(badge)
			}
		}

		// console.log('normal badges: ', normal_badges)
		// console.log('warning badges: ', warning_badges)

		const limitTH = options.hashrate/1000/1000


		if (normal_badges.length > 0) {
			let best_badge = {}
			let amount = 1000000
			for (let badge of normal_badges) {
				if (badge.amount < amount) {
					amount = badge.amount
					best_badge = badge
				}
			}

			let limit10Perc = limitTH * 0.10
			let minLimit = limitTH - limit10Perc
			if (best_badge.limit > minLimit)
				return best_badge

			let selected_badges = [best_badge]
			let hashes = 0
			if (best_badge.totalHashes < totalHashesDesired) {
				hashes += best_badge.totalHashes
				for (let badge of normal_badges) {
					if ((badge.totalHashes + hashes) <= totalHashesDesired) {
						selected_badges.push(badge)
						hashes += badge.totalHashes
					}
				}
			}
			if (hashes < totalHashesDesired) {
				for (let badge of warning_badges) {
					if ((badge.totalHashes + hashes) <= totalHashesDesired) {
						selected_badges.push(badge)
						hashes += badge.totalHashes
					}
				}
			}

			if (selected_badges.length > 0)
				return selected_badges
		}

		if (warning_badges.length > 0) {
			let cutoffs = []
			let low_balances = []
			for (let badge of warning_badges) {
				if (badge.status.type === LOW_BALANCE) {
					low_balances.push(badge)
				} else if (badge.type === CUTOFF) {
					cutoffs.push(badge)
				}
			}

			let selected_badges = []
			let hashes = 0;

			for (let badge of low_balances) {
				if ((badge.totalHashes + hashes) <= totalHashesDesired) {
					hashes += badge.limit
					selected_badges.push(badge)
				}
			}

			return selected_badges
		}
	}

	/**
	 * Manual rent based an amount of hashrate for a period of time
	 * @param {Object} options - The Options for the rental operation
	 * @param {Number} options.hashrate - The amount of Hashrate you wish to rent
	 * @param {Number} options.duration - The duration (IN HOURS) that you wish to rent hashrate for
	 * @param {Function} [options.rentSelector] - This function runs to let the user decide which rent option to go for. If no func is passed, will attempt to pick best possible rent opt.
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

		let badges = preprocess.badges
		if (options.rentSelector) {
			let selector = await options.rentSelector(preprocess, options)
			if (!selector.confirm)
				return {success: false, message: `Rental Cancelled`}
			badges = selector.badges
		} else {
			badges = await this.manualRentSelector(preprocess, options)
		}

		let rentals = []
		if (Array.isArray(badges)) {
			for (let badge of badges) {
				rentals.push(await badge.provider.manualRent(badge))
			}
		} else {
			rentals.push(await badges.provider.manualRent(badges))
		}

		return rentals
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
			amount,
			limit,
			duration,
			price: averagePrice,
			desiredLimit: options.hashrate/1000/1000
		}
	}

	/** Cutoff a NiceHash rental at a desired time
	 * @param {string|number} id - id of the rental
	 * @param {string|number} uid - the uid of the rental provider
	 * @param {number} duration - the amount of time to let the rental run
	 * @returns {void}
	 */
	cutoffRental(id, uid, duration) {
		let cutoffTime = Date.now() + duration * 60 * 60 * 1000
		let check = async () => {
			if (Date.now() >= cutoffTime) {
				let _provider
				for (let provider of this.rental_providers) {
					if (provider.getUID() === uid) {
						_provider = provider
						break
					}
				}
				let cancel = await _provider.cancelRental(id)
				if (cancel.success) {
					//ToDo: Write to log
					if (!this.cancellations) {
						this.cancellations = []
					}
					this.cancellations.push(cancel)
				} else {
					if (cancel.errorType === 'NETWORK') {
						//ToDo: Write to log
						setTimeout( check,  60 * 1000)
					}
					if (cancel.errorType === 'NICEHSAH') {
						//ToDo: Write to log
						console.log(`Failed to cancel order: ${id}`, cancel)
						if (!this.cancellations) {
							this.cancellations = []
						}
						this.cancellations.push(cancel)
					}
				}
			} else {
				setTimeout( check,  60 * 1000)
			}
		}
		setTimeout(check, 60 * 1000)
	}
}

export default AutoRenter