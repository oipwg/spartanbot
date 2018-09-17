import { MRRProvider } from './RentalProviders'

const SUPPORTED_RENTAL_PROVIDERS = [ MRRProvider ]

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
	 * @param {Boolean} [settings.memory=false] - Should SpartanBot only run in Memory and not save anything to disk
	 * @return {SpartanBot}
	 */
	constructor(settings){
		this.settings = settings || {}

		this.rental_providers = []

		// Try to load state from LocalStorage if we are not memory only
		if (!this.settings.memory)
			this._deserialize = this.deserialize()
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
	 * @param {String} key - What setting you wish to set
	 * @param {*} value - The value you wish to set the setting to
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
	 * @return {Promise<Object>} Returns a promise that will resolve after the rental provider has been setup
	 */
	async setupRentalProvider(settings){
		// Force settings to be passed
		if (!settings.type)
			throw new Error("settings.type is required!")
		if (!settings.api_key)
			throw new Error("settings.api_key is required!")
		if (!settings.api_secret)
			throw new Error("settings.api_secret is required!")

		// Match to a supported provider (if possible)
		let provider_match
		for (let provider of SUPPORTED_RENTAL_PROVIDERS){
			if (provider.getType() === settings.type){
				provider_match = provider;
			}
		}

		// Check if we didn't match to a provider
		if (!provider_match)
			throw new Error("No Provider found that matches settings.type")

		// Create the new provider
		let new_provider = new provider_match(settings)

		// Test to make sure the API keys work
		try {
			await new_provider.testAuthorization()
		} catch (e) {
			throw new Error("API Key and/or API Secret are not valid!\n" + e)
		}

		this.rental_providers.push(new_provider)

		// Save new Provider
		this.serialize()

		// Return info to the user
		return {
			message: "Successfully Setup Rental Provider",
			type: settings.type
		}
	}

	/**
	 * Get all of the Supported Rental Providers that you can Setup
	 * @return {Array.<String>} Returns an array containing all the supported providers "type" strings
	 */
	getSupportedRentalProviders(){
		let supported_provider_types = []

		// Itterate through all supported rental providers
		for (let provider of SUPPORTED_RENTAL_PROVIDERS){
			// Grab the type of the provider
			let provider_type = provider.getType()

			// Check if we have already added the provider to the array
			if (supported_provider_types.indexOf(provider_type) === -1){
				// If not, add it to the array
				supported_provider_types.push(provider_type)
			}
		}

		// Return the Array of all Supported Rental Provider types
		return supported_provider_types
	}

	/**
	 * Get all Rental Providers from SpartanBot
	 * @return {Array.<MRRProvider>} Returns an array containing all the available providers
	 */
	getRentalProviders(){
		return this.rental_providers
	}

	/**
	 * Delete a Rental Provider from SpartanBot
	 * @param  {String} uid - The uid of the Rental Provider to remove (can be acquired by running `.getUID()` on a RentalProvider)
	 * @return {Boolean} Returns true upon success
	 */
	deleteRentalProvider(uid){
		if (!uid)
			throw new Error("You must include the UID of the Provider you want to remove")

		let new_provider_array = []

		for (let i = 0; i < this.rental_providers.length; i++){
			if (this.rental_providers[i].getUID() !== uid){
				new_provider_array.push(this.rental_providers[i])
			}
		}

		this.rental_providers = new_provider_array

		this.serialize()

		return true
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
					total_hashrate: 2513,
					total_rigs: 1234
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

		if (!this.settings.memory)
			localStorage.setItem('spartanbot-storage', JSON.stringify(serialized))
	}

	/**
	 * Load all serialized (saved) data from LocalStorage
	 * @return {Boolean} Returns true on deserialize success
	 *
	 * @private
	 */
	async deserialize(){
		let data_from_storage = {}

		if (localStorage.getItem('spartanbot-storage'))
			data_from_storage = JSON.parse(localStorage.getItem('spartanbot-storage'))

		if (data_from_storage.settings)
			this.settings = Object.assign({}, data_from_storage.settings, this.settings)

		if (data_from_storage.rental_providers){
			for (let provider of data_from_storage.rental_providers){
				await this.setupRentalProvider(provider)
			}
		}

		return true
	}
}

export default SpartanBot