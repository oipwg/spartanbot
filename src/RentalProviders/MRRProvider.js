import RentalProvider from './RentalProvider'

/**
 * A Rental Provider for MiningRigRentals
 */
class MRRProvider extends RentalProvider {
	/**
	 * Create a new MRR Provider
	 * @param  {Object} settings - Settings for the RentalProvider
	 * @param {String} settings.api_key - The API Key for the Rental Provider
	 * @param {String} settings.api_secret - The API Secret for the Rental Provider
	 * @return {MRRProvider}
	 */
	constructor(settings){
		super(settings)
	}

	/**
	 * Get the "type" of this RentalProvider
	 * @return {String} Returns "MiningRigRentals"
	 * @static
	 */
	static getType(){
		return "MiningRigRentals"
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
			type: "MiningRigRentals",
			api_key: this.api_key,
			api_secret: this.api_secret,
			uid: this.uid
		}
	}
}

export default MRRProvider