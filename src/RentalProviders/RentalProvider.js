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
	 * @param {Array.<Object>} settings.pools - Array of pools (pool profiles for MRR)
	 * @param {String} [settings.uid] - The unique identifier for this Rental Provider
	 * @return {RentalProvider} 
	 */
	constructor(settings = {}){
		this.uid = settings.uid || uid()
		this.api_key = settings.api_key
		this.api_secret = settings.api_secret
		this.name = settings.name
		this.pools = []
		this.activePoolID = undefined
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
	 * Add pools to local variable this.pools
	 * @param pools
	 */
	addPools(pools) {
		this.pools.push(pools)
	}

	/**
	 * Fetch this.pools
	 * @returns {Array<Object>|*}
	 */
	getPools() {
		return this.pools
	}

	/**
	 * Set pool id to be the active pool ID for a provider (pool profile id for MRR)
	 * @param {number|string} id - pool id (pool profile id for MRR)
	 */
	setActivePoolID(id) {
		let setID = id
		if (typeof setID === 'string') {
			setID = Number(setID);
		} else if (typeof setID !== 'number') {
			return 'Error: ID must be of type string or number'
		}
		this.poolID = setID
	}

	/**
	 * Get pool id (pool profile id for MRR)
	 * @returns {number}
	 */
	getActivePoolID() {
		return this.poolID
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
			uid: this.uid,
			pools: this.pools,
			activePoolID: this.activePoolID
		}
	}
}

export default RentalProvider