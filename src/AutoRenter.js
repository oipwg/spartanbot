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
		// Mock function to respond for now...
		if (options.confirm){
			let confirmed = false

			try {
				confirmed = await options.confirm({
					total_cost: 25.31,
					total_hashrate: 2513,
					total_rigs: 7
				})
			} catch (e) {}

			if (!confirmed){
				return {
					success: false,
					info: "Manual Rental Cancelled"
				}
			}
		}

		return {
			success: true,
			info: "Successfully rented miners"
		}




		/***************************************/
		/*********** ACTUAL CODE ***************/
		/***************************************/
		// Make sure we have some Rental Providers, if not, return failure
		if (!(this.rental_providers.length >= 1)){
			return {
				success: false,
				type: "NO_RENTAL_PROVIDERS",
				message: "Rent Cancelled, no RentalProviders found to rent from"
			}
		}

		let rental_info = await this.rental_providers[0].rent({
			hashrate: options.hashrate,
			duration: options.duration,
			confirm: async (prepurchase_info) => {
				if (options.confirm){
					try {
						let should_continue = await options.confirm(prepurchase_info)
						return should_continue
					} catch (e) { 
						return false 
					}
				}
				return true
			}
		})

		return rental_info
	}
}

export default AutoRenter