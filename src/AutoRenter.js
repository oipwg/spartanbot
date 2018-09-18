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

		let rental_info = await this.rental_providers[0].rent({
			hashrate: options.hashrate,
			duration: hours,
			confirm: async (prepurchase_info) => {
				if (options.confirm){
					try {
						let btc_to_usd_rate = await this.exchange.getExchangeRate("bitcoin", "usd")

						let should_continue = await options.confirm({
							total_cost: (prepurchase_info.btc_total_price * btc_to_usd_rate).toFixed(2),
							total_hashrate: prepurchase_info.total_hashrate,
							total_rigs: prepurchase_info.rigs.length
						})

						return should_continue
					} catch (e) { 
						return false 
					}
				}
				return true
			}
		})

		let btc_to_usd_rate = await this.exchange.getExchangeRate("bitcoin", "usd")

		return {
			total_rigs_rented: rental_info.rented_rigs.length,
			total_cost: (rental_info.btc_total_price * btc_to_usd_rate).toFixed(2),
			total_hashrate: rental_info.total_hashrate
		}
	}
}

export default AutoRenter