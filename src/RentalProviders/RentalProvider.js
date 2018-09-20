import uid from 'uid'

/**
 * A Single Rental Provider API wrapper (to standardize between multiple providers)
 */
class RentalProvider {
	/**
	 * Create a new Rental Provider
	 * @param  {Object} settings - Settings for the RentalProvider
	 * @param {String} settings.api_key - The API Key for the Rental Provider
	 * @param {String} settings.api_secret - The API Secret for the Rental Provider
	 * @param {String} settings.name - Alias/arbitrary name for the provider
	 * @param {String} [settings.uid] - The unique identifier for this Rental Provider
	 * @return {RentalProvider} 
	 */
	constructor(settings = {}){
		this.uid = settings.uid || uid()
		this.api_key = settings.api_key
		this.api_secret = settings.api_secret
		this.name = settings.name
	}

	/**
	 * Get the "type" of this RentalProvider
	 * @return {String} Returns "RentalProvider"
	 * @static
	 */
	static getType(){
		return "RentalProvider"
	}

	getUID(){
		return this.uid
	}

	/**
	 * Test to make sure the API key and secret are correct
	 * @return {Promise} Returns a Promise that will resolve upon success, and reject on failure
	 */
	async testAuthorization(){
		return true
	}

	/**
	 * Get back a "Serialized" state of the Provider
	 * @return {Object} Returns a JSON object that contains the current rental provider state
	 */
	serialize(){
		return {
			type: "RentalProvider",
			api_key: this.api_key,
			api_secret: this.api_secret,
			uid: this.uid
		}
	}
}

export default RentalProvider