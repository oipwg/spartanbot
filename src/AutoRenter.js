import Exchange from 'oip-exchange-rate';

const NiceHash = "NiceHash"
const MiningRigRentals = "MiningRigRentals"

const toNiceHashPrice = (amount, hash, time) => {
	return (amount / hash / time) * 24
}
const toMRRAmount = (price, time, hash) => {
	return ((price/24)*time)*hash
}

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
	async mrrRentPreprocess(options) {
		//preprocess
		//ToDo: make sure providers profileIDs aren't the same

		//Assuming Provider type === 'MiningRigRentals'
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
			return {success: false, message: 'No MRR Providers to fetch rigs'}


		let rigs_to_rent = [];
		try {
			rigs_to_rent = await _provider.getRigsToRent(options.hashrate, options.duration)
		} catch (err) {
			throw new Error(`Failed to fetch rigs to rent \n ${err}`)
		}
		let rigs_found = rigs_to_rent.length
		//divvy up providers and create Provider object
		let providers = [], totalBalance = 0;
		for (let provider of mrr_providers) {
			//get the balance of each provider
			let balance = await provider.getBalance();
			totalBalance += balance
			//get the profile id needed to rent for each provider
			let profile = provider.returnActivePoolProfile() || await provider.getProfileID();
			providers.push({
				uid: provider.getUID(),
				balance,
				profile,
				rigs_to_rent: [],
				provider
			})
		}

		let hashrate_found = _provider.getTotalHashPower(rigs_to_rent)
		let cost_found = _provider.getRentalCost(rigs_to_rent)

		// console.log("total hashpower: ", hashpower_found)
		// console.log("total cost: ", cost_found)

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

		let btc_cost_to_rent = 0;
		let hashrate_to_rent = 0;
		let total_balance = 0
		let rigs = [];
		let rigs_length = 0;
		for (let p of providers) {
			btc_cost_to_rent += p.provider.getRentalCost(p.rigs_to_rent)
			hashrate_to_rent += p.provider.getTotalHashPower(p.rigs_to_rent)
			rigs_length += p.rigs_to_rent.length
			total_balance += p.balance

			for (let rig of p.rigs_to_rent) {
				rig.rental_info.profile = p.profile
				p.provider.setActivePoolProfile(p.profile)
				rigs.push({...rig.rental_info, providerUID: p.provider.getUID()})
			}
		}

		// rigs.sort((a,b) => {return a.rig - b.rig})
		// console.log(`Total hashrate + hashrate of extra rigs: ${total_hashrate + providers[0].provider.getTotalHashPower(extra_rigs)}`)

		return {
			//clarify the market for easy workings
			market: MiningRigRentals,
			//cost of all rigs initially found with given parameters
			cost_found,
			//hashpower of all rigs initially found with given parameters
			hashrate_found,
			//initial_rigs is the initial amount of rigs found that were queried for
			rigs_found,
			//total cost in btc to rent the rigs (total_rigs)
			btc_cost_to_rent,
			//total balance of all providers in the SpartanBot
			hashrate_to_rent,
			//total_rigs is the number of rigs found that can be rent
			rigs_length,
			//the actual JSON objects containing the information needed to rent each rig
			total_balance,
			//total hashpower of the rigs found to rent (total_rigs)
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
	 * @return {Promise<Object>} Returns a Promise that will resolve to an Object containing info about the rental made
	 */
	async manualRentPreprocess(options) {
		//get balances and create provider objects
		let providers = []
		for (let provider of this.rental_providers) {
			providers.push({
				type: provider.getInternalType(),
				balance: await provider.getBalance(),
				name: provider.getName(),
				uid: provider.getUID(),
				provider
			})
		}

		let capableProviders = []
		let incapableProviders = []

		//filter NiceHash providers if their balance is below 0.005 (NH min) or the hashrate desired is below .01TH (10GH or 10000MH) which is the NiceHash minimum
		for (let i = providers.length - 1; i >= 0; i--) {
			if (providers[i].type === NiceHash && (providers[i].balance < 0.005 || options.hashrate < 10000)) {
				incapableProviders.push({...providers[i], message: 'Balance must be >= .005BTC && desired hashrate must be >= 10Gh'})
				providers.splice(i, 1)
			} else {
				capableProviders.push(providers[i])
			}
		}

		//if only NiceHash and with insufficient funds return
		if (capableProviders.length === 0)
			return {success: false, message: "Insufficient Funds", incapableProviders}

		//check how much it would cost to rent from MRR
		let mrrPreprocess = {};
		let mrrExists = false
		for (let provider of capableProviders) {
			if (provider.type === MiningRigRentals) {
				mrrExists = true
				mrrPreprocess = await this.mrrRentPreprocess(options)
				break
			}
		}

		//if there's no MRR and we're here, there's at least 1 NiceHash with funds
		if (!mrrExists) {
			//calculate NH rent options and return
			let amount = 0.005
			let limit = options.hashrate / 1000 / 1000
			let duration = options.duration
			let price = (amount / limit / duration) * 24

			return {uid: capableProviders[0].uid, price, limit, amount}
		}

		//if the cost to rent rigs is less than the NiceHash minimum amount, remove the NiceHash providers
		if (mrrPreprocess.cost_found < 0.005) {
			for (let i = providers.length - 1; i >= 0; i--) {
				if (providers[i].type === NiceHash) {
					incapableProviders.push({...providers[i], message: 'The cost of the rigs on MRR is less than .005, the NiceHash minimum amount.'})
					providers.splice(i, 1)
				}
			}
		}

		//if we're here at least one MRR provider from here on out; check for NH providers
		let niceHashExist = false
		for (let provider of capableProviders) {
			if (provider.type === NiceHash)
				niceHashExist = true
		}

		if (!niceHashExist) { //then we only have MRR providers
			return mrrPreprocess
		}

		//if we're here, at least one MRR and NiceHash provider exist
		let amount = mrrPreprocess.btc_cost_to_rent // cost to rent rigs from MRR

		//check if the cost to rent from MRR is cheaper than it would be for NiceHash
		let rentWithNiceHash = amount > 0.005

		//Calculate NH Price per TH per day
		let hashrateMH = options.hashrate
		let limit = hashrateMH / 1000 / 1000 //convert to TeraHash
		let price = toNiceHashPrice(0.005, limit, options.duration) // btc/th/day

		if (rentWithNiceHash) {
			for (let provider of capableProviders) {
				if (provider.type === NiceHash) {
					return {limit, price, amount: 0.005, uid: provider.uid, market: NiceHash}
				}
			}
		}

		//Calculate MRR Price per TH per day
		let cost = mrrPreprocess.btc_cost_to_rent
		let hash = mrrPreprocess.hashrate_to_rent / 1000 / 1000 //convert to TeraHash
		let mrrPrice = toNiceHashPrice(cost, hash, options.duration) // btc/th/day

		//if MRR funds are low and we can't rent everything, if that cost compared to NH is greater than 10% cheaper, rent with MRR
		if (mrrPreprocess.hashrate_to_rent < mrrPreprocess.hashrate_found) {
			let margin = price * 0.10
			if (mrrPrice < (price - margin)) {
				return {...mrrPreprocess, status: "LOW FUNDS", message: "REFILL WALLET"}
			} else {
				for (let provider of capableProviders) {
					if (provider.type === NiceHash) {
						return {limit, price, amount: 0.005, uid: provider.uid, market: NiceHash}
					}
				}
			}
		}

		// else if price is lower than 0.005, then rent with MiningRigRentals
		return mrrPreprocess
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
		let prepurchase_info;
		try {
			prepurchase_info = await this.manualRentPreprocess(options)
		} catch (err) {
			throw new Error(`Failed to get prepurchase_info! \n ${err}`)
		}

		let market, cost, hash, pricePerThPerDay, duration = options.duration;

		if (prepurchase_info.market === NiceHash) {
			market = NiceHash;
			cost = prepurchase_info.amount
			hash = prepurchase_info.limit
			pricePerThPerDay = prepurchase_info.price
		}

		let status = {
			status: 'normal'
		}

		if (prepurchase_info.market === MiningRigRentals) {
			if (prepurchase_info.total_balance < prepurchase_info.cost_found) {
				status.status = 'warning';
				status.type = 'LOW_BALANCE_WARNING'
				status.totalBalance = prepurchase_info.total_balance
				status.total_cost = prepurchase_info.cost_found

				if (prepurchase_info.rigs_found === 0) {
					status.message = `Could not find any rigs to rent with available balance`
				} else {
					status.message = `${prepurchase_info.rigs_length}/${prepurchase_info.rigs_found} rigs available to rent with current balance.`
				}
			}
			market = MiningRigRentals
			cost = prepurchase_info.btc_cost_to_rent
			hash = prepurchase_info.hashrate_to_rent
			pricePerThPerDay = ((prepurchase_info.btc_cost_to_rent / (prepurchase_info.hashrate_to_rent / 1000000) / options.duration) * 24)
		}

		// -> confirm total
		if (options.confirm){
			try {
				let should_continue = await options.confirm({
					market,
					cost: cost.toFixed(6),
					pricePerThPerDay: pricePerThPerDay.toFixed(6),
					hash,
					duration,
					status,
				})

				if (!should_continue) {
					return {success: false, message: `Rental Cancelled`}
				}
			} catch (e) {
				return {success: false, message: `Rental Cancelled: \n ${e}`}
			}
		}

		//Do Stuff like rent and what not
		if (market === NiceHash) {
			let _provider;
			for (let provider of this.rental_providers) {
				if (provider.getUID() === prepurchase_info.uid) {
					_provider = provider
				}
			}
			let res;
			try {
				res = await _provider.rent({limit: prepurchase_info.limit, amount: prepurchase_info.amount, price: prepurchase_info.price})
			} catch (err) {
				throw new Error(`Failed to rent from NiceHash provider ${_provider.getUID}: ${err}`)
			}
			// ToDO: standardize the return variable for rent function
			return res
		}

		if (market === MiningRigRentals) {
			let rental_info
			try {
				rental_info = await this.rental_providers[0].rent(prepurchase_info.rigs)
			} catch (err) {
				throw new Error(`Error renting rigs in AutoRenter: \n ${err}`)
			}

			//check rental success
			if (!rental_info.success)
				return rental_info

			let total_rigs = 0

			if (rental_info.rented_rigs)
				total_rigs = rental_info.rented_rigs.length

			return {
				success: true,
				total_rigs_rented: total_rigs,
				total_cost: rental_info.btc_total_price,
				total_hashrate: rental_info.total_hashrate
			}
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