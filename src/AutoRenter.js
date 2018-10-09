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
	 *  // return example
	 *  {
	 *      //cost of all rigs initially found with given parameters
	 *      initial_cost,
	 *      //hashpower of all rigs initially found with given parameters
	 *      initial_hashpower,
	 *      //initial_rigs is the initial amount of rigs found that were queried for
	 *      initial_rigs,
	 *      //total cost in btc to rent the rigs (total_rigs)
	 *      btc_total_price,
	 *      //total balance of all providers in the SpartanBot
	 *      total_balance,
	 *      //total hashpower of the rigs found to rent (total_rigs)
	 *      total_hashrate,
	 *      //total_rigs is the number of rigs found that can be rent
	 *      total_rigs,
	 *      //the actual JSON objects containing the information needed to rent each rig
	 *      rigs,
	 *      //success to test against
	 *      success: true
	 *  }
	 */
	async rentPreprocess(options) {
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
		let initial_rigs = rigs_to_rent.length
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

		let initial_hashpower = providers[0].provider.getTotalHashPower(rigs_to_rent)
		let initial_cost = providers[0].provider.getRentalCost(rigs_to_rent)

		// console.log("total hashpower: ", initialHashPower)
		// console.log("total cost: ", initialCost)


		//load up work equally
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
			let rental_cost = p.provider.getRentalCost(p.rigs_to_rent);

			if (p.balance < rental_cost) {
				while (p.balance < rental_cost && p.rigs_to_rent.length > 0) {
					// console.log(`balance: ${p.balance}\nRental cost: ${rental_cost}\nOver Under: ${p.balance-rental_cost}\nAmount substracted -${p.rigs_to_rent[0].btc_price}\nLeft Over: ${rental_cost-p.rigs_to_rent[0].btc_price}`)
					let tmpRig;
					[tmpRig] = p.rigs_to_rent.splice(0,1)
					extra_rigs.push(tmpRig)

					rental_cost = p.provider.getRentalCost(p.rigs_to_rent)
				}
			}
		}

		for (let p of providers) {
			let rental_cost = p.provider.getRentalCost(p.rigs_to_rent);
			if (p.balance > rental_cost) {
				for (let i = extra_rigs.length -1; i >= 0; i--){
					if ((extra_rigs[i].btc_price + rental_cost) <= p.balance) {
						let tmpRig;
						[tmpRig] = extra_rigs.splice(i,1);
						p.rigs_to_rent.push(tmpRig)
						rental_cost = p.provider.getRentalCost(p.rigs_to_rent);
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
				rig.rental_info.profile = p.profile
				rigs.push(rig.rental_info)
			}
		}

		// rigs.sort((a,b) => {return a.rig - b.rig})
		// console.log(`Total hashrate + hashrate of extra rigs: ${total_hashrate + providers[0].provider.getTotalHashPower(extra_rigs)}`)

		return {
			//cost of all rigs initially found with given parameters
			initial_cost,
			//hashpower of all rigs initially found with given parameters
			initial_hashpower,
			//initial_rigs is the initial amount of rigs found that were queried for
			initial_rigs,
			//total cost in btc to rent the rigs (total_rigs)
			btc_total_price,
			//total balance of all providers in the SpartanBot
			total_balance,
			//total hashpower of the rigs found to rent (total_rigs)
			total_hashrate,
			//total_rigs is the number of rigs found that can be rent
			total_rigs,
			//the actual JSON objects containing the information needed to rent each rig
			rigs,
			//success to test against
			success: true
		}
	}
	
	/**
	 * Rent an amount of hashrate for a period of time
	 * @param {Object} options - The Options for the rental operation
	 * @param {Number} options.hashrate - The amount of Hashrate you wish to rent
	 * @param {Number} options.duration - The duration (IN SECONDS) that you wish to rent hashrate for
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
			prepurchase_info = await this.rentPreprocess(options)
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

			if (prepurchase_info.numOfRigsFound === 0) {
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