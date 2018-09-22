import Exchange from 'oip-exchange-rate';

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

	/** Preprocess rent
	 * @param {Object} options - The Options for the rental operation
	 * @param {Number} options.hashrate - The amount of Hashrate you wish to rent
	 * @param {Number} options.duration - The duration (in seconds) that you wish to rent hashrate for
	 * @returns {Promise<Object>}
	 * @example
	 *
	 */
	async manualRentPreprocess(options) {
		//preprocess
		//ToDo: make sure providers profileIDs aren't the same

		//Assuming Provider type === 'MiningRigRentals'
		//get available rigs based on hashpower and duration
		let rigs_to_rent = [];
		try {
			rigs_to_rent = await this.rental_providers[0].getRigsToRent(options.hashrate, options.duration)
		} catch (err) {
			throw new Error(`Failed to fetch rigs to rent \n ${err}`)
		}
		let numOfRigsFound = rigs_to_rent.length
		//divvy up providers and create Provider object
		let providers = [], totalBalance = 0;
		for (let provider of this.rental_providers) {
			//get the balance of each provider
			let balance = await provider.getBalance();
			totalBalance += balance
			//get the profile id needed to rent for each provider
			let profile = await provider.getProfileID();
			providers.push({
				uid: provider.uid,
				balance,
				profile,
				rigs_to_rent: [],
				provider
			})
		}

		//load up work equally
		let iterator = 0;
		let len = providers.length
		for (let i = 0; i < rigs_to_rent.length; i++) {
			if (i === len || iterator === len) {
				iterator = 0
			}

			let tmpRig = rigs_to_rent[i]
			tmpRig.rental_info.profile = providers[iterator].profile

			providers[iterator].rigs_to_rent.push(tmpRig)
			iterator += 1
		}


		let extra_rigs = []
		for (let p of providers) {
			let rental_cost = p.provider.getRentalCost(p.rigs_to_rent);

			if (p.balance < rental_cost) {
				while (p.balance < rental_cost && p.rigs_to_rent.length) {
					extra_rigs.push(p.rigs_to_rent.splice(0,1))
				}
			}
		}

		for (let p of providers) {
			let rental_cost = p.provider.getRentalCost(p.rigs_to_rent);

			if (p.balance > rental_cost) {
				for (let rig of extra_rigs) {
					if ((rig.btc_price + rental_cost) <= p.balance) {
						p.rigs_to_rent.push(rig)
					}
				}
			}
		}

		let btc_total_price = 0;
		let total_hashrate = 0;
		let total_balance = 0
		let total_rigs = 0;
		let rigs = [];
		for (let p of providers) {
			btc_total_price += p.provider.getRentalCost(p.rigs_to_rent)
			total_hashrate += p.provider.getTotalHashPower(p.rigs_to_rent)
			total_rigs += p.rigs_to_rent.length
			total_balance += p.balance

			for (let rig of p.rigs_to_rent) {
				rigs.push(rig.rental_info)
			}
		}

		return {
			btc_total_price,
			total_hashrate,
			total_balance,
			total_rigs,
			numOfRigsFound,
			rigs
		}
	}
	
	/**
	 * Rent an amount of hashrate for a period of time
	 * @param {Object} options - The Options for the rental operation
	 * @param {Number} options.hashrate - The amount of Hashrate you wish to rent
	 * @param {Number} options.duration - The duration (in seconds) that you wish to rent hashrate for
	 * @param {Function} [options.confirm] - This function will be run to decide if the rental should proceed. If it returns `true`, the rental will continue, if false, the rental cancels
	 * @return {Promise<Object>} Returns a Promise that will resolve to an Object containing info about the rental made
	 */
	async rent(options){
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
			prepurchase_info = await this.manualRentPreprocess(options)
		} catch (err) {
			throw new Error(`Failed to get prepurchase_info! \n ${err}`)
		}

		let status = {
			status: 'normal'
		}

		if (prepurchase_info.total_balance < prepurchase_info.btc_total_price) {
			status = {
				status: 'warning',
				type: 'LOW_BALANCE_WARNING',
				currentBalance: prepurchase_info.total_balance
			}
			if (prepurchase_info.numOfRigsFound === 0) {
				status.message = `Could not find any rigs to rent with available balance`
			} else {
				status.message = `${prepurchase_info.rigs.length} rigs available to rent with current balance out of ${prepurchase_info.total_rigs} rigs found`
			}
		}

		// -> confirm total
		if (options.confirm){
			try {
				let btc_to_usd_rate = await this.exchange.getExchangeRate("bitcoin", "usd")

				let should_continue =  await options.confirm({
					total_cost: (prepurchase_info.btc_total_price * btc_to_usd_rate).toFixed(2),
					total_hashrate: prepurchase_info.total_hashrate,
					total_rigs: prepurchase_info.total_rigs,
					status: prepurchase_info.status
				})
				if (!should_continue) {
					return false
				}
			} catch (e) {
				return false
			}
		}

		//rent
		let rental_info = await this.rental_providers[0].rent(prepurchase_info.rigs)

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