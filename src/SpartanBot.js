let localStorage

if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
	if (typeof localStorage === "undefined") {
		var LocalStorage = require('node-localstorage').LocalStorage;
		localStorage = new LocalStorage('./localStorage');
	}
} else {localStorage = window.localStorage}

let waitFn = async (time) => {
	setTimeout(() => { return }, time || 1000)
}

/**
 * Rent hashrate based on a set of circumstances
 */
class SpartanBot {
	/**
	 * Create a new SpartanBot
	 * @param  {Object} settings - The settings for the SpartanBot node
	 * @return {SpartanBot}
	 */
	constructor(settings){
		this.settings = settings || {}

		this.rental_providers = []

		// Try to load state from LocalStorage
		this.deserialize()
	}

	/**
	 * Get a setting back from SpartanBot
	 * @param  {String} key - The setting key you wish to get the value of
	 * @return {Object|String|Array.<Object>} Returns the value of the requested setting
	 */
	getSetting(key){
		return this.settings[key]
	}

	/**
	 * Set a setting
	 * @param {[type]} key   [description]
	 * @param {[type]} value [description]
	 */
	setSetting(key, value){
		if (key !== undefined && value !== undefined)
			this.settings[key] = value

		// Save the latest
		this.serialize()
	}

	/**
	 * Setup a new Rental Provider for use
	 * @param {Object} settings - The settings for the Rental Provider
	 * @param {String} settings.type - The "type" of the rental provider. Currently only accepts "MiningRigRentals".
	 * @param {String} settings.api_key - The API Key for the Rental Provider
	 * @param {String} settings.api_secret - The API Secret for the Rental Provider
	 * @return {[type]} [description]
	 */
	async setupRentalProvider(settings){
		await waitFn(2000)

		return {
			success: true,
			message: "Successfully Setup Rental Provider"
		}
	}
	
	/**
	 * Run a Manual Rental instruction
	 * @param  {Number} hashrate - The hashrate you wish to rent (in MegaHash)
	 * @param  {Number} duration - The number of seconds that you wish to rent the miners for
	 * @param  {Function} [confirmation] - Pass in a function that returns a Promise to offer confirmation to the user
	 * @return {Promise<Object>} Returns a Promise that will resolve to an Object that contains information about the rental request
	 */
	async manualRental(hashrate, duration, confirmation){
		await waitFn()

		// Check if the user wants to proceed with the purchase
		if (confirmation){
			let confirmed = false

			try {
				confirmed = await confirmation({
					total_cost: 25.31,
					total_hashrate: 2513
				})
			} catch (e) {}

			if (!confirmed){
				return {
					success: false,
					info: "Manual Rental Cancelled"
				}
			}
		}

		await waitFn()

		return {
			success: true,
			info: "Successfully rented miners"
		}		
	}

	/**
	 * Serialize all information about SpartanBot to LocalStorage (save the current state)
	 * @return {Boolean} Returns true if successful
	 *
	 * @private
	 */
	serialize(){
		let serialized = {
			rental_providers: []
		}

		serialized.settings = JSON.parse(JSON.stringify(this.settings))

		for (let provider of this.rental_providers){
			serialized.rental_providers.push(provider.serialize())
		}

		localStorage.setItem('spartanbot-storage', JSON.stringify(serialized))
	}

	/**
	 * Load all serialized (saved) data from LocalStorage
	 * @return {Boolean} Returns true on deserialize success
	 *
	 * @private
	 */
	deserialize(){
		let data_from_storage = {}

		if (localStorage.getItem('spartanbot-storage'))
			data_from_storage = JSON.parse(localStorage.getItem('spartanbot-storage'))

		if (data_from_storage.settings)
			this.settings = Object.assign({}, data_from_storage.settings, this.settings)

		if (data_from_storage.rental_providers){
			for (let provider of data_from_storage.rental_providers){
				// this.rental_providers.push()
			}
		}

		return true
	}
}

export default SpartanBot